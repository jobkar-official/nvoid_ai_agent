import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ApplicationResult, ApplicationTask, JobProfile, NormalizedJob } from '../common/job.types';
import { resolveTemplate } from '../common/template-resolver';
import { assertPublicHttpUrl, assertSafeHttpUrl } from '../common/url-safety';
import { McpRegistryService } from '../mcp/mcp-registry.service';
import { AiAgentService } from '../common/ai-agent.service';

@Injectable()
export class ApplicationExecutorService implements OnModuleDestroy {
  private readonly logger = new Logger(ApplicationExecutorService.name);
  private browserPromise?: Promise<Browser>;

  constructor(
    private readonly configService: ConfigService,
    private readonly mcpRegistry: McpRegistryService,
    private readonly aiAgent: AiAgentService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (!this.browserPromise) return;
    try {
      const browser = await this.browserPromise;
      await browser.close();
    } catch {
      // Browser was not started or exited before shutdown.
    }
  }

  async execute(task: ApplicationTask): Promise<ApplicationResult> {
    const base = {
      userId: task.userId,
      jobId: task.job.id,
      source: task.job.source,
      jobTitle: task.job.title,
      company: task.job.company,
      applicationUrl: task.job.applicationUrl ?? task.job.jobUrl,
      completedAt: new Date().toISOString(),
    };

    const targetUrl = task.job.applicationUrl ?? task.job.jobUrl;
    const ruleViolation = checkHardPreferenceConflicts(task.profile, task.job);
    if (ruleViolation) {
      return { ...base, status: 'SKIPPED', message: ruleViolation };
    }
    const submitEnabledForTask = task.autoSubmit === true && this.configService.get<boolean>('autoSubmitEnabled', false);
    const browserAutoSubmitAllowed = this.isAutoSubmitAllowed(task, targetUrl);
    const mcpApplication = this.mcpRegistry.getJobApplicationConfig(task.job.source);

    if (submitEnabledForTask && mcpApplication) {
      try {
        const args = resolveTemplate(mcpApplication.argumentsTemplate, { profile: task.profile, job: task.job });
        const result = await this.mcpRegistry.callTool(mcpApplication.server.id, mcpApplication.tool, args);
        const confirmed = inspectSubmissionConfirmation(result);
        const output: ApplicationResult = {
          ...base,
          status: confirmed.confirmed ? 'APPLIED' : 'NEEDS_USER_ACTION',
          message: confirmed.confirmed
            ? 'Application connector returned a submission confirmation.'
            : 'The application connector returned, but no reliable submission confirmation was found. Verify the application before retrying.',
          externalApplicationId: confirmed.applicationId,
        };
        return output;
      } catch (error) {
        const output: ApplicationResult = {
          ...base,
          status: 'NEEDS_USER_ACTION',
          message: `The MCP application call did not return a verifiable result. Check the destination before retrying. ${messageOf(error)}`,
        };
        return output;
      }
    }

    if (!targetUrl) {
      const output: ApplicationResult = {
        ...base,
        status: 'NEEDS_USER_ACTION',
        message: 'No job or application URL was provided by the discovery source.',
      };
      return output;
    }

    if (mcpApplication && !submitEnabledForTask) {
      const output: ApplicationResult = {
        ...base,
        status: 'NEEDS_USER_ACTION',
        message: 'An application MCP tool is configured, but auto-submission is disabled or this task is not authorized to submit automatically.',
      };
      return output;
    }

    let target: URL;
    try {
      target = await assertPublicHttpUrl(targetUrl);
    } catch (error) {
      const output: ApplicationResult = {
        ...base,
        status: 'NEEDS_USER_ACTION',
        message: `Application URL was blocked by URL safety checks: ${messageOf(error)}`,
      };
      return output;
    }

    let context: BrowserContext | undefined;
    try {
      const browser = await this.getBrowser();
      context = await browser.newContext({ acceptDownloads: false });
      const page = await context.newPage();
      page.setDefaultTimeout(this.configService.get<number>('browserActionTimeoutMs', 15000));
      page.setDefaultNavigationTimeout(this.configService.get<number>('browserNavigationTimeoutMs', 30000));
      await this.guardMainFrameNavigations(page);
      await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });

      const finalUrl = await assertPublicHttpUrl(page.url());
      if (await this.isCaptchaPage(page)) {
        const screenshotPath = await this.takeScreenshot(page, task.job.id, 'blocked');
        const output: ApplicationResult = {
          ...base,
          applicationUrl: finalUrl.toString(),
          status: 'NEEDS_USER_ACTION',
          message: 'The destination requires CAPTCHA or human verification. The agent will not attempt to bypass it.',
          screenshotPath,
        };
        return output;
      }

      if (await page.locator('input[type="password"]').count() > 0 && /sign in|log in|login|password/i.test(await page.locator('body').innerText().catch(() => ''))) {
        const screenshotPath = await this.takeScreenshot(page, task.job.id, 'login-required');
        const output: ApplicationResult = {
          ...base,
          applicationUrl: finalUrl.toString(),
          status: 'NEEDS_USER_ACTION',
          message: 'The destination requires an authenticated user session. No account password was requested or entered.',
          screenshotPath,
        };
        return output;
      }

      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (/take (the )?(assessment|test)|complete (the )?(assessment|test)|coding challenge|online assessment/i.test(bodyText)) {
        const screenshotPath = await this.takeScreenshot(page, task.job.id, 'assessment-required');
        const output: ApplicationResult = {
          ...base,
          applicationUrl: finalUrl.toString(),
          status: 'NEEDS_USER_ACTION',
          message: 'The application appears to require an assessment or test. This workflow stops for user action.',
          screenshotPath,
        };
        return output;
      }

      if (await this.countVisibleFormFields(page) === 0) {
        await this.clickStartApplicationIfPresent(page);
      }

      const fieldCount = await this.countVisibleFormFields(page);
      if (fieldCount === 0) {
        const screenshotPath = await this.takeScreenshot(page, task.job.id, 'no-form-detected');
        const output: ApplicationResult = {
          ...base,
          applicationUrl: page.url(),
          status: 'NEEDS_USER_ACTION',
          message: 'No supported application form was detected. Open the original listing and continue manually.',
          screenshotPath,
        };
        return output;
      }

      const hasCoverLetter = await this.hasCoverLetterField(page);
      let tailoredCoverLetter: string | undefined;
      if (hasCoverLetter) {
        try { tailoredCoverLetter = await this.aiAgent.generateCoverLetter(task.profile, task.job); }
        catch (error) { this.logger.warn(`Could not generate a tailored cover letter: ${messageOf(error)}`); }
      }
      const profileForForm = tailoredCoverLetter ? { ...task.profile, summary: tailoredCoverLetter } : task.profile;
      const fillResult = await this.fillSupportedFields(page, profileForForm, task.job);
      const screenshotPath = await this.takeScreenshot(page, task.job.id, 'form-prepared');

      if (fillResult.requiredUnfilled.length > 0) {
        const output: ApplicationResult = {
          ...base,
          applicationUrl: page.url(),
          status: 'NEEDS_USER_ACTION',
          message: `Some required fields need user input: ${fillResult.requiredUnfilled.slice(0, 8).join(', ')}. Review the application manually.`,
          screenshotPath,
        };
        return output;
      }

      if (!browserAutoSubmitAllowed || !this.isAllowedAutoApplyUrl(page.url())) {
        const output: ApplicationResult = {
          ...base,
          applicationUrl: page.url(),
          status: 'NEEDS_USER_ACTION',
          message: `The form was prepared in a temporary worker session (${fillResult.filled} field(s) filled), but submission is disabled. Use the original application URL to review and submit manually.`,
          screenshotPath,
        };
        return output;
      }

      const submitButton = await this.findSubmitButton(page);
      if (!submitButton) {
        const output: ApplicationResult = {
          ...base,
          applicationUrl: page.url(),
          status: 'NEEDS_USER_ACTION',
          message: 'The form was prepared, but no supported final submission button was identified. No submit action was taken.',
          screenshotPath,
        };
        return output;
      }

      try {
        await submitButton.click();
        await page.waitForTimeout(1800);
      } catch (error) {
        const screenshotAfter = await this.takeScreenshot(page, task.job.id, 'submit-uncertain');
        const output: ApplicationResult = {
          ...base,
          applicationUrl: page.url(),
          status: 'NEEDS_USER_ACTION',
          message: `A submit action may have been triggered but could not be verified. Check the destination before any retry. ${messageOf(error)}`,
          screenshotPath: screenshotAfter ?? screenshotPath,
        };
        return output;
      }

      const afterText = await page.locator('body').innerText().catch(() => '');
      const afterUrl = page.url();
      const confirmed = /application (was )?(submitted|received)|successfully applied|thank you for applying|we received your application|your application has been sent|application complete/i.test(afterText)
        || /confirmation|application-submitted|thank-you/i.test(afterUrl);
      const finalScreenshot = await this.takeScreenshot(page, task.job.id, confirmed ? 'submitted' : 'submit-unverified');
      const output: ApplicationResult = {
        ...base,
        applicationUrl: afterUrl,
        status: confirmed ? 'APPLIED' : 'NEEDS_USER_ACTION',
        message: confirmed
          ? 'The career page displayed a submission confirmation.'
          : 'The submit action was triggered, but the page did not provide a reliable confirmation. Verify manually before retrying.',
        screenshotPath: finalScreenshot ?? screenshotPath,
      };
      return output;
    } catch (error) {
      const output: ApplicationResult = {
        ...base,
        status: 'FAILED',
        message: `Application worker failed before it could verify a submission. Do not automatically retry if the destination may have received the request. ${messageOf(error)}`,
      };
      return output;
    } finally {
      if (context) await context.close().catch(() => undefined);
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({ headless: this.configService.get<boolean>('browserHeadless', true) });
    }
    return this.browserPromise;
  }

  private async guardMainFrameNavigations(page: Page): Promise<void> {
    const checkedHosts = new Map<string, Promise<void>>();
    await page.route('**/*', async (route) => {
      const request = route.request();
      const rawUrl = request.url();
      let requestedUrl: URL;
      try {
        requestedUrl = new URL(rawUrl);
      } catch {
        await route.abort('blockedbyclient');
        return;
      }

      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        if (!['http:', 'https:', 'about:'].includes(requestedUrl.protocol)
          || (requestedUrl.protocol === 'about:' && requestedUrl.href !== 'about:blank')) {
          await route.abort('blockedbyclient');
          return;
        }
      }

      if (requestedUrl.protocol === 'http:' || requestedUrl.protocol === 'https:') {
        const host = requestedUrl.hostname.toLowerCase();
        let check = checkedHosts.get(host);
        if (!check) {
          check = assertPublicHttpUrl(requestedUrl.toString()).then(() => undefined);
          checkedHosts.set(host, check);
        }
        try {
          await check;
        } catch {
          checkedHosts.delete(host);
          await route.abort('blockedbyclient');
          return;
        }
      } else if (!['about:', 'data:', 'blob:'].includes(requestedUrl.protocol)) {
        await route.abort('blockedbyclient');
        return;
      }

      await route.continue();
    });
  }

  private async countVisibleFormFields(page: Page): Promise<number> {
    const fields = page.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
    const count = await fields.count();
    let visible = 0;
    for (let i = 0; i < Math.min(count, 100); i++) {
      const field = fields.nth(i);
      if (await field.isVisible().catch(() => false)) visible++;
    }
    return visible;
  }

  private async clickStartApplicationIfPresent(page: Page): Promise<void> {
    const candidates = page.getByRole('button', { name: /^(apply now|apply for this job|start application|continue to application)$/i });
    const count = await candidates.count();
    if (count > 0 && await candidates.first().isVisible().catch(() => false)) {
      await Promise.allSettled([
        page.waitForLoadState('domcontentloaded', { timeout: 5000 }),
        candidates.first().click({ timeout: 5000 }),
      ]);
    }
  }

  private async hasCoverLetterField(page: Page): Promise<boolean> {
    const fields = page.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea');
    const count = Math.min(await fields.count(), 100);
    for (let index = 0; index < count; index++) {
      const descriptor = await fields.nth(index).evaluate((element) => {
        const el = element as HTMLInputElement | HTMLTextAreaElement;
        const labels = 'labels' in el && el.labels ? Array.from(el.labels).map((label) => label.innerText).join(' ') : '';
        return `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') ?? ''} ${labels}`.toLowerCase();
      }).catch(() => '');
      if (/cover[ _-]?letter|why[ _-]?are[ _-]?you[ _-]?interested|message[ _-]?to[ _-]?hiring|application[ _-]?letter/.test(descriptor)) return true;
    }
    return false;
  }

  private async fillSupportedFields(page: Page, profile: JobProfile, job: NormalizedJob): Promise<{ filled: number; requiredUnfilled: string[] }> {
    const fields = page.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
    const count = Math.min(await fields.count(), 120);
    let filled = 0;
    const requiredUnfilled: string[] = [];
    const resumePath = this.resolveResumePath(profile.resumePath);

    for (let index = 0; index < count; index++) {
      const field = fields.nth(index);
      if (!await field.isVisible().catch(() => false)) continue;
      const metadata = await field.evaluate((element) => {
        const el = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const labels = 'labels' in el && el.labels ? Array.from(el.labels).map((label) => label.innerText).join(' ') : '';
        return {
          type: (el as HTMLInputElement).type ?? el.tagName.toLowerCase(),
          name: el.getAttribute('name') ?? '',
          id: el.id ?? '',
          placeholder: el.getAttribute('placeholder') ?? '',
          ariaLabel: el.getAttribute('aria-label') ?? '',
          autocomplete: el.getAttribute('autocomplete') ?? '',
          label: labels,
          required: el.required ?? el.getAttribute('aria-required') === 'true',
          value: el.tagName.toLowerCase() === 'select' ? (el as HTMLSelectElement).value : (el as HTMLInputElement).value ?? '',
        };
      }).catch(() => undefined);
      if (!metadata) continue;
      const type = metadata.type.toLowerCase();
      const descriptor = `${metadata.name} ${metadata.id} ${metadata.placeholder} ${metadata.ariaLabel} ${metadata.autocomplete} ${metadata.label}`.toLowerCase();

      if (type === 'password' || type === 'checkbox' || type === 'radio' || type === 'hidden' || type === 'submit' || type === 'button') continue;

      if (type === 'file') {
        if (resumePath && /resume|cv|curriculum|upload|file|document/i.test(descriptor)) {
          try { await field.setInputFiles(resumePath); filled++; } catch {
            if (metadata.required) requiredUnfilled.push(metadata.label || metadata.name || metadata.id || 'resume/file upload');
          }
        } else if (metadata.required) {
          requiredUnfilled.push(metadata.label || metadata.name || metadata.id || 'resume/file upload');
        }
        continue;
      }

      const value = profileValueForField(descriptor, profile, job);
      if (value === undefined || value === '') {
        if (metadata.required && !metadata.value) requiredUnfilled.push(metadata.label || metadata.name || metadata.id || `field-${index + 1}`);
        continue;
      }

      if (metadata.value.trim()) continue;
      try {
        if (type === 'select-one' || type === 'select-multiple' || await field.locator('option').count() > 0) {
          const text = String(value);
          try { await field.selectOption({ label: text }, { timeout: 1200 }); }
          catch { await field.selectOption({ value: text }, { timeout: 1200 }); }
        } else if (['email', 'tel', 'url', 'text', 'number', 'search', 'textarea', 'date'].includes(type) || field) {
          await field.fill(String(value), { timeout: 1200 });
        }
        filled++;
      } catch {
        if (metadata.required) requiredUnfilled.push(metadata.label || metadata.name || metadata.id || `field-${index + 1}`);
      }
    }

    return { filled, requiredUnfilled: [...new Set(requiredUnfilled)] };
  }

  private resolveResumePath(value?: string): string | undefined {
    if (!value) return undefined;
    const configuredRoot = resolve(this.configService.get<string>('resumeStorageDir', './private-resumes'));
    const candidate = isAbsolute(value) ? resolve(value) : resolve(configuredRoot, value);
    const rel = relative(configuredRoot, candidate);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      this.logger.warn('Resume path was blocked because it is outside RESUME_STORAGE_DIR.');
      return undefined;
    }
    if (!existsSync(candidate)) return undefined;
    return candidate;
  }

  private async findSubmitButton(page: Page): Promise<Locator | undefined> {
    const roleButton = page.getByRole('button', { name: /^(submit( application)?|send application|finish application|complete application|apply|apply now)$/i });
    const roleCount = await roleButton.count();
    for (let i = roleCount - 1; i >= 0; i--) {
      const candidate = roleButton.nth(i);
      if (await candidate.isVisible().catch(() => false) && await candidate.isEnabled().catch(() => false)) return candidate;
    }
    const inputSubmit = page.locator('input[type="submit"]');
    const inputCount = await inputSubmit.count();
    for (let i = inputCount - 1; i >= 0; i--) {
      const candidate = inputSubmit.nth(i);
      if (await candidate.isVisible().catch(() => false) && await candidate.isEnabled().catch(() => false)) return candidate;
    }
    return undefined;
  }

  private async isCaptchaPage(page: Page): Promise<boolean> {
    const selectors = [
      'iframe[src*="captcha" i]',
      'iframe[src*="recaptcha" i]',
      'iframe[src*="turnstile" i]',
      '[id*="captcha" i]',
      '[class*="captcha" i]',
      'textarea[name="g-recaptcha-response"]',
      'input[name="cf-turnstile-response"]',
    ];
    for (const selector of selectors) {
      if (await page.locator(selector).count().catch(() => 0) > 0) return true;
    }
    const bodyText = await page.locator('body').innerText().catch(() => '');
    return /verify you are human|prove you are human|are you a robot|complete the captcha|captcha challenge|security verification/i.test(bodyText);
  }

  private async takeScreenshot(page: Page, jobId: string, label: string): Promise<string | undefined> {
    try {
      const directory = resolve(this.configService.get<string>('screenshotDir', './artifacts'));
      await mkdir(directory, { recursive: true });
      const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
      const path = resolve(directory, `${safeId}-${label}-${Date.now()}.png`);
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      return path;
    } catch (error) {
      this.logger.warn(`Unable to save application screenshot: ${messageOf(error)}`);
      return undefined;
    }
  }

  private isAutoSubmitAllowed(task: ApplicationTask, targetUrl?: string): boolean {
    if (!task.autoSubmit || !this.configService.get<boolean>('autoSubmitEnabled', false) || !targetUrl) return false;
    return this.isAllowedAutoApplyUrl(targetUrl);
  }

  private isAllowedAutoApplyUrl(targetUrl: string): boolean {
    let url: URL;
    try { url = assertSafeHttpUrl(targetUrl); } catch { return false; }
    const allowed = this.configService.get<string[]>('allowedAutoApplyDomains', []);
    const host = url.hostname.toLowerCase();
    return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
  }

}


function checkHardPreferenceConflicts(profile: JobProfile, job: NormalizedJob): string | undefined {
  const currenciesCompatible = !profile.salaryCurrency || !job.salaryCurrency
    || profile.salaryCurrency.toUpperCase() === job.salaryCurrency.toUpperCase();
  if (currenciesCompatible && profile.salaryMin !== undefined && job.salaryMax !== undefined && job.salaryMax < profile.salaryMin) {
    return "Skipped because the published maximum salary is below the user's minimum salary preference.";
  }
  if (currenciesCompatible && profile.salaryMax !== undefined && job.salaryMin !== undefined && job.salaryMin > profile.salaryMax) {
    return "Skipped because the published minimum salary is above the user's maximum salary preference.";
  }
  if (profile.employmentTypes?.length && job.employmentType) {
    const preferred = profile.employmentTypes.map((value) => value.toLowerCase().replace(/[^a-z]/g, ''));
    const actual = job.employmentType.toLowerCase().replace(/[^a-z]/g, '');
    if (!preferred.some((value) => actual.includes(value) || value.includes(actual))) {
      return "Skipped because the published employment type does not match the user's selected employment types.";
    }
  }
  return undefined;
}

function profileValueForField(descriptor: string, profile: JobProfile, job: NormalizedJob): string | number | undefined {
  const values: Array<[RegExp, unknown]> = [
    [/\b(first|given)[ _-]?name\b/, profile.firstName ?? profile.fullName?.split(/\s+/)[0]],
    [/\b(last|family|sur)[ _-]?name\b/, profile.lastName ?? profile.fullName?.split(/\s+/).slice(1).join(' ')],
    [/\b(full|your|applicant|candidate)?[ _-]?name\b/, profile.fullName ?? [profile.firstName, profile.lastName].filter(Boolean).join(' ')],
    [/e-?mail/, profile.email],
    [/phone|mobile|telephone|contact[ _-]?number/, profile.phone],
    [/linkedin/, profile.linkedinUrl],
    [/portfolio|website|personal[ _-]?site/, profile.portfolioUrl],
    [/current[ _-]?company|employer/, profile.currentCompany],
    [/current[ _-]?(job[ _-]?)?title|current[ _-]?position/, profile.currentTitle],
    [/years?[ _-]?(of[ _-]?)?experience|experience[ _-]?years/, profile.experienceYears],
    [/expected[ _-]?salary|salary[ _-]?expectation|desired[ _-]?salary|salary[ _-]?requirement/, profile.salaryMin],
    [/cover[ _-]?letter|professional[ _-]?summary|about[ _-]?you|summary|why[ _-]?this[ _-]?role/, profile.summary],
    [/skills|technical[ _-]?stack|technologies/, profile.skills?.join(', ')],
    [/city|location|address/, profile.location],
    [/job[ _-]?title|position[ _-]?applied[ _-]?for|role[ _-]?applied/, job.title],
  ];
  for (const [pattern, value] of values) {
    if (pattern.test(descriptor) && value !== undefined && value !== null) return value as string | number;
  }
  return undefined;
}

function inspectSubmissionConfirmation(result: unknown): { confirmed: boolean; applicationId?: string } {
  if (!result || typeof result !== 'object') return { confirmed: false };
  const root = result as Record<string, unknown>;
  const structured = root.structuredContent && typeof root.structuredContent === 'object'
    ? root.structuredContent as Record<string, unknown>
    : {};
  const serialized = JSON.stringify(result).toLowerCase();
  const status = String(structured.status ?? structured.applicationStatus ?? '').toLowerCase();
  const confirmed = structured.success === true
    || structured.applied === true
    || ['applied', 'submitted', 'success', 'successful', 'application_received', 'application_submitted'].includes(status)
    || /application (was )?(submitted|received)|successfully applied|application submitted successfully/.test(serialized);
  const applicationIdValue = structured.applicationId ?? structured.application_id ?? structured.id;
  return {
    confirmed,
    applicationId: typeof applicationIdValue === 'string' || typeof applicationIdValue === 'number' ? String(applicationIdValue) : undefined,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
