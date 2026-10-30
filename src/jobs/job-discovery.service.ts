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
  sources: Array<{ serverId: string; tool: string; found: number; error?: string; report?: SearchSourceReport; detailsRequested?: number; detailsFetched?: number; detailTool?: string }>;
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

  getSearchSources() {
    const searchable = new Map(this.mcpRegistry.getJobSearchServers().map((entry) => [entry.server.id, entry]));
    return this.mcpRegistry.getStatuses().map((status) => {
      const jobSource = searchable.get(status.id);
      return {
        ...status,
        jobSearchAvailable: Boolean(jobSource),
        searchTool: jobSource?.tool,
      };
    });
  }

  async search(profile: JobProfile, limit: number, serverIds?: string[], syncToBackend = true): Promise<SearchResult> {
    if (!profile.jobTitle?.trim()) throw new BadRequestException('Enter a target job title before searching.');
    if (!profile.location?.trim() && !(profile.countries ?? []).some((country) => country.trim() && !/^(worldwide|global|anywhere|remote|all countries)$/i.test(country.trim()))) {
      throw new BadRequestException('Enter a preferred city, region, or country. Use Worldwide only when you want a global search.');
    }

    const maximum = this.configService.get<number>('maxSearchResults', 200);
    const requestedLimit = Math.min(Math.max(1, limit), maximum);
    const effectiveProfile: JobProfile = { ...profile, location: profile.location?.trim() || (profile.countries ?? []).filter((country) => country.trim()).join(', ') || 'Worldwide' };
    const servers = this.mcpRegistry.getJobSearchServers().filter((item) => serverIds === undefined || serverIds.includes(item.server.id));
    if (servers.length === 0) {
      throw new ServiceUnavailableException('No connected MCP server has a configured or discoverable job-search tool. Configure jobSearch.tool for each MCP server in config/mcp-servers.json.');
    }

    const sourceResults: Array<{ serverId: string; tool: string; jobs: NormalizedJob[]; error?: string; report?: SearchSourceReport; detailsRequested?: number; detailsFetched?: number; detailTool?: string }> = await Promise.all(servers.map(async (entry) => {
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
          : entry.server.id === 'aidevboard'
            ? {
                ...(toolArgs ?? {}),
                query: [effectiveProfile.jobTitle, effectiveProfile.location].filter(Boolean).join(' '),
              }
            : toolArgs;
        const result = entry.server.id === 'jobicy'
          ? await this.callJobicyWithCache(entry.server.id, entry.tool, sourceArgs)
          : await this.mcpRegistry.callTool(entry.server.id, entry.tool, sourceArgs);
        const searchId = extractSearchId(result);
        const parsedJobs = entry.server.id === 'jobdatalake' ? parseJobDataLakeSearchResult(result) : parseMcpJobResult(result);
        const rawJobs = parsedJobs.map((raw) => {
          if (!searchId || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
          return { ...(raw as Record<string, unknown>), search_id: searchId };
        });
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
    const sourceForJobId = new Map<string, string>();
    for (const sourceResult of sourceResults) {
      for (const job of sourceResult.jobs) {
        const dedupeKey = (job.applicationUrl ?? job.jobUrl ?? `${job.title}|${job.company ?? ''}|${job.location ?? ''}`).toLowerCase().replace(/\/$/, '');
        const existing = deduplicated.get(dedupeKey);
        if (!existing || job.matchScore > existing.matchScore) {
          deduplicated.set(dedupeKey, job);
          sourceForJobId.set(job.id, sourceResult.serverId);
        }
      }
    }

    const candidates = [...deduplicated.values()].map((job) => {
      const raw = job.raw ?? {};
      const match = calculateMatchScore(raw, job.title, job.location, profile);
      return { ...job, matchScore: Math.max(job.matchScore, match.score), matchReasons: [...new Set([...job.matchReasons, ...match.reasons])] };
    });
    const initiallyRanked = candidates.sort((a, b) => b.matchScore - a.matchScore);
    const detailTargetsBySource = new Map<string, NormalizedJob[]>();
    for (const job of initiallyRanked) {
      const serverId = sourceForJobId.get(job.id);
      if (!serverId) continue;
      const sourceTargets = detailTargetsBySource.get(serverId) ?? [];
      if (sourceTargets.length < 3) {
        sourceTargets.push(job);
        detailTargetsBySource.set(serverId, sourceTargets);
      }
    }
    const detailTargets = [...detailTargetsBySource.values()].flat().slice(0, 24);
    const detailResults = await Promise.all(detailTargets.map((job) => this.enrichJobDetails(
      job,
      sourceForJobId.get(job.id),
      profile,
    )));
    const detailById = new Map(detailResults.map((result) => [result.job.id, result.job]));
    for (const sourceResult of sourceResults) {
      const requested = detailTargetsBySource.get(sourceResult.serverId) ?? [];
      const providerDetails = detailResults.filter((result) => result.serverId === sourceResult.serverId);
      sourceResult.detailsRequested = requested.length;
      sourceResult.detailsFetched = providerDetails.filter((result) => result.fetched).length;
      sourceResult.detailTool = providerDetails.find((result) => result.tool)?.tool;
    }
    const rankedWithDetails = initiallyRanked.map((job) => detailById.get(job.id) ?? job);
    const aiCandidates = rankedWithDetails.slice(0, Math.min(100, rankedWithDetails.length));
    const AIranked = await this.aiAgent.rerankJobs(profile, aiCandidates);
    const jobs = [...AIranked, ...rankedWithDetails.slice(aiCandidates.length)].sort((a, b) => b.matchScore - a.matchScore).slice(0, requestedLimit);

    let backendSync: { synced: boolean; reason?: string } = { synced: false, reason: 'Backend sync disabled for this search.' };
    if (syncToBackend) backendSync = await this.backendSync.syncJobs(profile.userId, profile, jobs);

    return {
      requestedLimit,
      returnedCount: jobs.length,
      sourceCount: sourceResults.length,
      jobs,
      sources: sourceResults.map((entry) => ({ serverId: entry.serverId, tool: entry.tool, found: entry.jobs.length, error: entry.error, report: entry.report, detailsRequested: entry.detailsRequested, detailsFetched: entry.detailsFetched, detailTool: entry.detailTool })),
      searchReport: sourceResults.flatMap((entry) => entry.report ? [entry.report] : []),
      backendSync,
    };
  }


  private async enrichJobDetails(job: NormalizedJob, serverId: string | undefined, profile: JobProfile): Promise<{ job: NormalizedJob; serverId?: string; fetched: boolean; tool?: string }> {
    if (!serverId) return { job, fetched: false };
    const tools = this.mcpRegistry.getToolCatalog(serverId).flatMap((entry) => entry.tools);
    const detailTool = tools.find((tool) => isJobDetailTool(tool.name));
    if (!detailTool) return { job, serverId, fetched: false };
    const args = buildJobDetailArguments(detailTool.inputSchema, job, profile);
    if (!args) return { job, serverId, fetched: false, tool: detailTool.name };

    try {
      const result = await this.mcpRegistry.callTool(serverId, detailTool.name, args);
      const detailRecords = serverId === 'jobdatalake' ? parseJobDataLakeDetailResult(result) : parseMcpJobResult(result);
      const detail = detailRecords.find((value) => value && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown> | undefined;
      if (!detail) return { job, serverId, fetched: false, tool: detailTool.name };
      const raw = { ...(job.raw ?? {}), ...detail };
      const normalized = normalizeJob(raw, job.source, profile);
      if (!normalized) return { job: { ...job, raw }, serverId, fetched: true, tool: detailTool.name };
      const match = calculateMatchScore(raw, normalized.title, normalized.location, profile);
      return {
        job: {
          ...job,
          ...normalized,
          matchScore: Math.max(job.matchScore, normalized.matchScore, match.score),
          matchReasons: [...new Set([...job.matchReasons, ...normalized.matchReasons, ...match.reasons])],
          raw,
        },
        serverId,
        fetched: true,
        tool: detailTool.name,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`Job detail lookup skipped for ${serverId}/${detailTool.name}: ${message}`);
      return { job, serverId, fetched: false, tool: detailTool.name };
    }
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


export 
export export function parseJobDataLakeSearchResult(result: unknown): unknown[] {
  const text = extractMcpText(result);
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const jobs: Array<Record<string, unknown>> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^\s*\d+\.\s+\*\*(.+?)\*\*\s+at\s+(.+?)\s*$/.exec(lines[index]);
    if (!heading) continue;
    const locationLine = lines[index + 1]?.trim() ?? '';
    const skillsLine = lines[index + 2]?.trim() ?? '';
    const applyLine = lines[index + 3]?.trim() ?? '';
    const idLine = lines[index + 4]?.trim() ?? '';
    const locationParts = locationLine.split(/\s+\|\s+/);
    const apply = /^Apply:\s*(.*)$/i.exec(applyLine)?.[1]?.trim() ?? '';
    const handle = /^ID:\s*(.*)$/i.exec(idLine)?.[1]?.trim() ?? '';
    const skills = /^Skills:\s*(.*)$/i.exec(skillsLine)?.[1]?.trim() ?? '';
    if (!handle || !/^Apply:/i.test(applyLine) || !/^ID:/i.test(idLine)) continue;

    jobs.push({
      id: handle,
      job_handle: handle,
      title: heading[1].trim(),
      company: heading[2].trim(),
      location: locationParts[0] || undefined,
      workMode: locationParts[1] || undefined,
      salary: locationParts.slice(2).join(' | ') || undefined,
      skills,
      description: skills ? `Required skills: ${skills}` : undefined,
      url: apply || undefined,
      applicationUrl: apply || undefined,
      source: 'jobdatalake',
    });
    index += 4;
  }

  return jobs;
}

export export function parseJobDataLakeDetailResult(result: unknown): unknown[] {
  const text = extractMcpText(result);
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const heading = /^\*\*(.+?)\*\*\s+at\s+(.+?)\s*$/.exec(lines[0]?.trim() ?? '');
  if (!heading) return [];
  const separatorIndex = lines.findIndex((line) => line.trim() === '---');
  const metadata = lines.slice(0, separatorIndex >= 0 ? separatorIndex : lines.length);
  const readField = (label: string) => {
    const prefix = `${label.toLowerCase()}:`;
    const line = metadata.find((item) => item.trim().toLowerCase().startsWith(prefix));
    return line ? line.trim().slice(prefix.length).trim() : undefined;
  };
  const description = separatorIndex >= 0 ? lines.slice(separatorIndex + 1).join('\n').trim() : undefined;
  const raw: Record<string, unknown> = {
    title: heading[1].trim(),
    company: heading[2].trim(),
    location: readField('Location'),
    salary: readField('Salary'),
    seniority: readField('Seniority'),
    experience_level: readField('Seniority'),
    skills: readField('Skills'),
    employment_type: readField('Type'),
    job_type: readField('Type'),
    applicationUrl: readField('Apply'),
    url: readField('Apply'),
    description,
    workMode: readField('Location')?.toLowerCase().includes('remote') ? 'Remote' : undefined,
  };
  return [raw];
}

function extractMcpText(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const root = result as Record<string, unknown>;
  if (Array.isArray(root.content)) {
    const texts = root.content
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => item.text)
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    if (texts.length) return texts.join('\n');
  }
  if (typeof root.text === 'string') return root.text;
  return undefined;
}

function extractSearchId(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try { return extractSearchId(JSON.parse(text) as unknown, depth + 1); } catch { return undefined; }
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractSearchId(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const direct = record.search_id ?? record.searchId ?? record.searchID;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  for (const key of ['structuredContent', 'content', 'text', 'result', 'data', 'output']) {
    if (key in record) {
      const found = extractSearchId(record[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

export function isJobDetailTool(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized === 'get_job'
    || /(?:^|_)get_job_details?$/.test(normalized)
    || /(?:^|_)(?:fetch|retrieve)_job_details?$/.test(normalized)
    || /(?:^|_)job_details?$/.test(normalized);
}

export function buildJobDetailArguments(schemaValue: unknown, job: NormalizedJob, profile: JobProfile): Record<string, unknown> | undefined {
  if (!schemaValue || typeof schemaValue !== 'object') return undefined;
  const schema = schemaValue as { properties?: Record<string, { type?: string }>; required?: string[] };
  const properties = schema.properties ?? {};
  if (Object.keys(properties).length === 0) return undefined;
  const raw = job.raw ?? {};
  const jobId = raw.id ?? raw.jobId ?? raw.job_id ?? raw.jobKey ?? raw.job_key ?? raw.job_handle ?? raw.jobHandle ?? raw.key ?? raw.slug ?? job.sourceJobId;
  const searchId = raw.search_id ?? raw.searchId ?? raw.searchID;
  const country = raw.country ?? raw.country_name ?? profile.countries?.[0] ?? inferCountry(profile);
  const args: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const [name, metadata] of Object.entries(properties)) {
    const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    let value: unknown;
    if (compact === 'searchid' || compact === 'searchidentifier') value = searchId;
    else if (compact === 'jobids' || compact === 'ids') value = jobId === undefined ? undefined : [String(jobId)];
    else if (/^(id|jobid|jobkey|jobhandle|key|jobcode|slug|jobslug|jobidentifier)$/.test(compact)) value = jobId;
    else if (/^(url|joburl|jobpostingurl|postingurl|link)$/.test(compact)) value = job.jobUrl ?? job.applicationUrl;
    else if (/^(country|countryname|countrycode)$/.test(compact)) value = country;
    else if (/^(company|companyname|employer)$/.test(compact)) value = job.company;
    else if (/^(location|loc)$/.test(compact)) value = job.location ?? profile.location;
    else if (/^(limit|count|n|resultswanted)$/.test(compact)) value = 1;
    if (value !== undefined) {
      args[name] = metadata.type === 'array' && !Array.isArray(value) ? [value] : value;
    } else if ((schema.required ?? []).includes(name)) {
      missing.push(name);
    }
  }

  return missing.length > 0 ? undefined : args;
}

function inferCountry(profile: JobProfile): string | undefined {
  const text = `${profile.location ?? ''} ${(profile.countries ?? []).join(' ')}`.toLowerCase();
  if (/\b(india|bengaluru|bangalore|delhi|noida|gurugram|gurgaon|mumbai|hyderabad|chennai|pune|kolkata)\b/.test(text)) return 'India';
  if (/\b(united states|usa|new york|san francisco|california|texas|seattle|boston)\b/.test(text)) return 'United States';
  if (/\b(united kingdom|uk|london|manchester)\b/.test(text)) return 'United Kingdom';
  return undefined;
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
    if (serverId === 'linkedin-mcp-zero') return 'linkedin';
    if (serverId === 'himalayas-mcp') return 'himalayas';
    return serverId;
  }
  const record = raw as Record<string, unknown>;
  if (serverId === 'apify-apna') return 'apna';
  if (serverId === 'linkedin-mcp-zero') return 'linkedin';
  if (serverId === 'himalayas-mcp') return 'himalayas';
  if (serverId === 'apify-boards' || serverId === 'mcp-jobspy-speedyapply') {
    const source = String(record.source ?? record.site ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const sources: Record<string, string> = {
      naukri: 'naukri',
      linkedin: 'linkedin',
      indeed: 'indeed',
      glassdoor: 'glassdoor',
      ziprecruiter: 'ziprecruiter',
      bayt: 'bayt',
      bdjobs: 'bdjobs',
      hellowork: 'hellowork',
    };
    return sources[source] ?? (serverId === 'mcp-jobspy-speedyapply' ? 'jobspy' : 'apify-boards');
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
    if (/^(q|kw|query|querytext|keyword|keywords|search|searchtext|searchterm|searchquery|term|jobtitle|title|position|role|job|jobname)$/.test(compact)) value = /s$/.test(compact) && metadata.type === 'array' ? [profile.jobTitle, ...(profile.keywords ?? [])] : [profile.jobTitle, ...(profile.keywords ?? [])].filter(Boolean).join(' ');
    else if (/^(loc|location|locationname|city|cityname|region|geo|geography|place|joblocation|preferredlocation)$/.test(compact)) value = profile.location ?? profile.countries?.join(', ');
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
