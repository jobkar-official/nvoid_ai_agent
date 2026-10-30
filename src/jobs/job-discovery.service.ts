import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JobProfile, NormalizedJob } from '../common/job.types';
import { BackendSyncService } from '../common/backend-sync.service';
import { resolveTemplate } from '../common/template-resolver';
import { AiAgentService } from '../common/ai-agent.service';
import { McpRegistryService } from '../mcp/mcp-registry.service';
import { calculateMatchScore, normalizeJob, parseMcpJobResult, resolveRemoteOkApplicationUrl } from './job-normalizer';
import { matchesJobLocation, matchesJobTitle } from './job-relevance';

export interface SearchResult {
  requestedLimit: number;
  returnedCount: number;
  sourceCount: number;
  jobs: NormalizedJob[];
  sources: Array<{ serverId: string; tool: string; found: number; error?: string; report?: SearchSourceReport }>;
  searchReport: SearchSourceReport[];
  backendSync: { synced: boolean; reason?: string };
}

export interface SearchSourceReport {
  serverId: string;
  provider?: string;
  mode?: string;
  queryCount?: number;
  requestsMade?: number;
  rawIndexedResults?: number;
  uniqueRoleLocationUrls?: number;
  linkedJobUrlsDiscovered?: number;
  publicJobPagesFetched?: number;
  structuredJobPages?: number;
  metadataOnlyListings?: number;
  matchedJobs?: number;
  returnedJobs?: number;
  targetCount?: number;
  reachedRequestedLimit?: boolean;
  moreSearchResultsAvailable?: boolean;
  failedSearchRequests?: number;
  rejectedUrlResults?: number;
  rejectedRoleResults?: number;
  rejectedLocationResults?: number;
  opportunityTypes?: Record<string, number>;
  truncated?: boolean;
}

@Injectable()
export class JobDiscoveryService {
  private readonly logger = new Logger(JobDiscoveryService.name);
  private readonly jobicyCache = new Map<string, { expiresAt: number; result: unknown }>();

  constructor(
    private readonly mcpRegistry: McpRegistryService,
    private readonly backendSync: BackendSyncService,
    private readonly configService: ConfigService,
    private readonly aiAgent: AiAgentService,
  ) {}

  async search(profile: JobProfile, limit: number, serverIds?: string[], syncToBackend = true): Promise<SearchResult> {
    if (!profile.jobTitle?.trim()) throw new BadRequestException('Enter a target job title before searching.');
    if (!profile.location?.trim() && !(profile.countries ?? []).some((country) => country.trim() && !/^(worldwide|global|anywhere|remote|all countries)$/i.test(country.trim()))) {
      throw new BadRequestException('Enter a preferred city, region, or country. Use Worldwide only when you want a global search.');
    }

    const maximum = this.configService.get<number>('maxSearchResults', 200);
    const requestedLimit = Math.min(Math.max(1, limit), maximum);
    const effectiveProfile: JobProfile = { ...profile, location: profile.location?.trim() || (profile.countries ?? []).filter((country) => country.trim()).join(', ') || 'Worldwide' };
    const servers = this.mcpRegistry.getJobSearchServers().filter((item) => !serverIds?.length || serverIds.includes(item.server.id));
    if (servers.length === 0) {
      throw new ServiceUnavailableException('No connected MCP server has a configured or discoverable job-search tool. Configure jobSearch.tool for each MCP server in config/mcp-servers.json.');
    }

    const sourceResults: Array<{ serverId: string; tool: string; jobs: NormalizedJob[]; error?: string; report?: SearchSourceReport }> = await Promise.all(servers.map(async (entry) => {
      try {
        const args = entry.configured
          ? resolveTemplate(entry.argumentsTemplate, { profile: effectiveProfile, limit: requestedLimit })
          : inferArguments(entry.inputSchema, profile, requestedLimit);
        if (!entry.configured && args === undefined) {
          return { serverId: entry.server.id, tool: entry.tool, jobs: [] as NormalizedJob[], error: 'Could not safely infer the required arguments. Define jobSearch.tool and jobSearch.arguments in mcp-servers.json.' };
        }

        const toolArgs = entry.server.id === 'jobicy'
          ? {
              ...(args ?? {}),
              tag: effectiveProfile.jobTitle,
              geo: resolveJobicyGeo(effectiveProfile),
              count: 200,
            }
          : args ?? {};
        const sourceArgs = entry.server.id === 'remoteok'
          ? {
              ...(args ?? {}),
              query: effectiveProfile.jobTitle,
              location: effectiveProfile.location,
              limit: Math.min(100, requestedLimit),
            }
          : toolArgs;
        const result = entry.server.id === 'jobicy'
          ? await this.callJobicyWithCache(entry.server.id, entry.tool, sourceArgs)
          : await this.mcpRegistry.callTool(entry.server.id, entry.tool, sourceArgs);
        const rawJobs = parseMcpJobResult(result);
        const jobs = rawJobs
          .map((raw) => normalizeJob(raw, resolveSourceId(entry.server.id, raw), profile))
          .filter((job): job is NormalizedJob => Boolean(job))
          .map((job) => {
            if (entry.server.id === 'remoteok') {
              const directUrl = job.raw?.apply_url ?? job.raw?.applyUrl ?? job.raw?.application_url;
              const applicationUrl = resolveRemoteOkApplicationUrl(job.jobUrl, directUrl);
              return { ...job, applicationUrl, workMode: job.workMode ?? 'Remote' };
            }
            if (entry.server.id === 'apify-boards' || entry.server.id === 'apify-apna') {
              const directUrl = job.raw?.directUrl ?? job.raw?.job_url_direct ?? job.raw?.applicationUrl ?? job.raw?.application_url;
              const applicationUrl = resolveRemoteOkApplicationUrl(job.jobUrl, directUrl);
              return { ...job, applicationUrl };
            }
            if (['jobicy', 'arbeitnow', 'workingnomads', 'himalayas', 'adzuna', 'jooble', 'remotive', 'weworkremotely', 'greenhouse', 'lever', 'ashby', 'serper-search'].includes(entry.server.id)) {
              return { ...job, applicationUrl: undefined };
            }
            return job;
          })
          .filter((job) => matchesJobTitle(job.title, job.raw, profile.jobTitle, profile.experienceYears))
          .filter((job) => matchesJobLocation(job, profile));
        return { serverId: entry.server.id, tool: entry.tool, jobs, report: parseSearchReport(result, entry.server.id) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Job discovery from ${entry.server.id}/${entry.tool} failed: ${message}`);
        return { serverId: entry.server.id, tool: entry.tool, jobs: [] as NormalizedJob[], error: message };
      }
    }));

    const deduplicated = new Map<string, NormalizedJob>();
    for (const sourceResult of sourceResults) {
      for (const job of sourceResult.jobs) {
        const dedupeKey = (job.applicationUrl ?? job.jobUrl ?? `${job.title}|${job.company ?? ''}|${job.location ?? ''}`).toLowerCase().replace(/\/$/, '');
        const existing = deduplicated.get(dedupeKey);
        if (!existing || job.matchScore > existing.matchScore) deduplicated.set(dedupeKey, job);
      }
    }

    const candidates = [...deduplicated.values()].map((job) => {
      const raw = job.raw ?? {};
      const match = calculateMatchScore(raw, job.title, job.location, profile);
      return { ...job, matchScore: Math.max(job.matchScore, match.score), matchReasons: [...new Set([...job.matchReasons, ...match.reasons])] };
    });
    const initiallyRanked = candidates.sort((a, b) => b.matchScore - a.matchScore);
    const aiCandidates = initiallyRanked.slice(0, Math.min(100, initiallyRanked.length));
    const AIranked = await this.aiAgent.rerankJobs(profile, aiCandidates);
    const jobs = [...AIranked, ...initiallyRanked.slice(aiCandidates.length)].sort((a, b) => b.matchScore - a.matchScore).slice(0, requestedLimit);

    let backendSync: { synced: boolean; reason?: string } = { synced: false, reason: 'Backend sync disabled for this search.' };
    if (syncToBackend) backendSync = await this.backendSync.syncJobs(profile.userId, profile, jobs);

    return {
      requestedLimit,
      returnedCount: jobs.length,
      sourceCount: sourceResults.length,
      jobs,
      sources: sourceResults.map((entry) => ({ serverId: entry.serverId, tool: entry.tool, found: entry.jobs.length, error: entry.error, report: entry.report })),
      searchReport: sourceResults.flatMap((entry) => entry.report ? [entry.report] : []),
      backendSync,
    };
  }

  private async callJobicyWithCache(serverId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const cacheKey = JSON.stringify({ serverId, tool, tag: args.tag, geo: args.geo });
    const now = Date.now();
    const cached = this.jobicyCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.result;
    if (cached) this.jobicyCache.delete(cacheKey);

    const result = await this.mcpRegistry.callTool(serverId, tool, args);
    for (const [key, value] of this.jobicyCache) {
      if (value.expiresAt <= now) this.jobicyCache.delete(key);
    }
    if (this.jobicyCache.size >= 200) {
      const oldestKey = this.jobicyCache.keys().next().value;
      if (oldestKey) this.jobicyCache.delete(oldestKey);
    }
    this.jobicyCache.set(cacheKey, { expiresAt: now + 60 * 60 * 1000, result });
    return result;
  }
}

function parseSearchReport(result: unknown, serverId: string): SearchSourceReport | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const root = result as Record<string, unknown>;
  let structured = root.structuredContent;
  if (!structured && Array.isArray(root.content)) {
    const item = root.content.find((entry) => entry && typeof entry === 'object' && 'text' in entry) as Record<string, unknown> | undefined;
    if (typeof item?.text === 'string') { try { structured = JSON.parse(item.text) as unknown; } catch { return undefined; } }
  }
  if (!structured || typeof structured !== 'object') return undefined;
  const metadata = (structured as Record<string, unknown>).searchMetadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  return { serverId, ...(metadata as Omit<SearchSourceReport, 'serverId'>) };
}

function resolveSourceId(serverId: string, raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return serverId;
  }
  const record = raw as Record<string, unknown>;
  if (serverId === 'apify-apna') return 'apna';
  if (serverId === 'apify-boards') {
    const source = String(record.source ?? record.site ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const sources: Record<string, string> = {
      naukri: 'naukri',
      linkedin: 'linkedin',
      indeed: 'indeed',
      glassdoor: 'glassdoor',
      ziprecruiter: 'ziprecruiter',
      bayt: 'bayt',
    };
    return sources[source] ?? 'apify-boards';
  }
  return serverId;
}

function inferArguments(schemaValue: unknown, profile: JobProfile, limit: number): Record<string, unknown> | undefined {
  if (!schemaValue || typeof schemaValue !== 'object') return undefined;
  const schema = schemaValue as { properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>; required?: string[] };
  const properties = schema.properties ?? {};
  if (Object.keys(properties).length === 0) return undefined;
  const result: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const [name, metadata] of Object.entries(properties)) {
    const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    let value: unknown;
    if (/^(q|query|querytext|keyword|keywords|search|searchtext|searchterm|searchquery|term|jobtitle|title|position|role|job|jobname)$/.test(compact)) value = /s$/.test(compact) && metadata.type === 'array' ? [profile.jobTitle, ...(profile.keywords ?? [])] : [profile.jobTitle, ...(profile.keywords ?? [])].filter(Boolean).join(' ');
    else if (/^(location|locationname|city|cityname|region|geo|geography|place|joblocation|preferredlocation)$/.test(compact)) value = profile.location ?? profile.countries?.join(', ');
    else if (/^(country|countries|countrycode)$/.test(compact)) value = metadata.type === 'array' ? profile.countries : profile.countries?.[0] ?? profile.location;
    else if (/^(skills|skill|technologies|techstack)$/.test(compact)) value = metadata.type === 'array' ? profile.skills : profile.skills?.join(', ');
    else if (/^(experience|experienceyears|minexperience|yearsofexperience|experiencelevel)$/.test(compact)) value = profile.experienceYears;
    else if (/^(salarymin|minsalary|minimumsalary|salaryfrom)$/.test(compact)) value = profile.salaryMin;
    else if (/^(salarymax|maxsalary|maximumsalary|salaryto)$/.test(compact)) value = profile.salaryMax;
    else if (/^(currency|salarycurrency)$/.test(compact)) value = profile.salaryCurrency;
    else if (/^(remote|remoteonly|isremote)$/.test(compact)) value = profile.remote;
    else if (/^(limit|count|pageSize|maxresults|maxrows|numresults|resultlimit|perpage|pagesize|take)$/.test(compact)) value = limit;
    else if (/^(jobtype|employmenttype|employmenttypes)$/.test(compact)) value = metadata.type === 'array' ? profile.employmentTypes : profile.employmentTypes?.join(', ');
    else if (/^(userId|userid)$/.test(compact)) value = profile.userId;
    if (value !== undefined) result[name] = value;
    else if ((schema.required ?? []).includes(name)) missing.push(name);
  }

  return missing.length > 0 ? undefined : result;
}

export function resolveJobicyGeo(profile: JobProfile): string {
  const location = (profile.location ?? '').trim().toLowerCase();
  const broadLocation = !location || /\b(remote|worldwide|global|anywhere|all locations|all countries)\b/.test(location);

  if (!broadLocation) {
    const region = regionForJobicyLocation(location);
    if (region) return region;
  }

  const preferredRegions = [...new Set((profile.countries ?? []).map((country) => regionForJobicyLocation(country.toLowerCase())).filter((value): value is string => Boolean(value)))];
  return preferredRegions.length === 1 ? preferredRegions[0] : 'anywhere';
}

function regionForJobicyLocation(value: string): string | undefined {
  if (/\b(canada|toronto|vancouver|montreal|calgary|ottawa|edmonton)\b/.test(value)) return 'canada';
  if (/\b(india|bengaluru|bangalore|delhi|mumbai|hyderabad|chennai|pune|kolkata|asia|apac|singapore|australia|japan|new zealand|philippines|pakistan|nepal|sri lanka|indonesia|thailand|vietnam|hong kong|malaysia)\b/.test(value)) return 'apac';
  if (/\b(europe|united kingdom|uk|london|germany|berlin|france|paris|netherlands|amsterdam|ireland|dublin|spain|italy|poland|sweden|norway|finland|portugal|switzerland|austria|belgium|denmark)\b/.test(value)) return 'europe';
  if (/\b(usa|united states|america|new york|san francisco|california|texas|seattle|austin|chicago|boston|los angeles)\b/.test(value)) return 'usa';
  return undefined;
}
