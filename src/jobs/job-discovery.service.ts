import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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
  sources: Array<{
    serverId: string;
    tool: string;
    found: number;
    fetchedCount: number;
    normalizedCount: number;
    roleMatchedCount: number;
    locationMatchedCount: number;
    connectionStatus: JobSourceResult['connectionStatus'];
    error?: string;
    report?: SearchSourceReport;
    detailsRequested?: number;
    detailsFetched?: number;
    detailTool?: string;
    skipReason?: string;
  }>;
  searchReport: SearchSourceReport[];
  backendSync: { synced: boolean; reason?: string };
  orchestration: {
    connectedMcpServers: number;
    connectedSearchTools: number;
    executedSearchTools: number;
    queryPlanner: 'llm-assisted' | 'deterministic';
    llmTitleExpansionUsed: boolean;
    titleVariants: string[];
  };
}

type JobSourceResult = {
  serverId: string;
  tool: string;
  jobs: NormalizedJob[];
  error?: string;
  report?: SearchSourceReport;
  detailsRequested?: number;
  detailsFetched?: number;
  detailTool?: string;
  fetchedCount: number;
  normalizedCount: number;
  roleMatchedCount: number;
  locationMatchedCount: number;
  skipReason?: string;
  connectionStatus: 'searched' | 'search-error' | 'disconnected' | 'no-search-tool' | 'skipped';
};

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
  atsBoardsDiscovered?: number;
  atsBoardsFetched?: number;
  atsJobsFetched?: number;
  atsBoardFailures?: number;
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
    const searchable = new Map<string, Array<{ tool: string; configured: boolean }>>();
    for (const entry of this.mcpRegistry.getJobSearchServers()) {
      const entries = searchable.get(entry.server.id) ?? [];
      entries.push({ tool: entry.tool, configured: entry.configured });
      searchable.set(entry.server.id, entries);
    }
    return this.mcpRegistry.getStatuses().map((status) => {
      const jobSources = searchable.get(status.id) ?? [];
      const preferred = jobSources.find((entry) => entry.configured) ?? jobSources[0];
      return {
        ...status,
        jobSearchAvailable: jobSources.length > 0,
        searchTool: preferred?.tool,
        searchTools: jobSources.map((entry) => entry.tool),
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
    let titleVariants: string[] = [];
    if (servers.some((entry) => entry.server.id === 'serper-search') && this.aiAgent.isEnabled()) {
      try {
        const descriptions = new Map(this.mcpRegistry.getToolCatalog().flatMap((server) => server.tools.map((tool) => [
          server.serverId + ':' + tool.name,
          tool.description ?? server.serverName,
        ] as const)));
        const proposed = await this.aiAgent.planJobSearchTitleVariants(effectiveProfile, servers.map((entry) => ({
          serverId: entry.server.id,
          toolName: entry.tool,
          description: descriptions.get(entry.server.id + ':' + entry.tool),
          inputSchema: entry.inputSchema,
        })));
        titleVariants = [...new Set(proposed.filter((variant) => (
          variant.toLowerCase() !== effectiveProfile.jobTitle.toLowerCase()
          && matchesJobTitle(variant, undefined, effectiveProfile.jobTitle, effectiveProfile.experienceYears)
        )))].slice(0, 5);
      } catch (error) {
        this.logger.warn('LLM job-title expansion failed; deterministic source queries will be used: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    const sourceResults: JobSourceResult[] = await Promise.all(servers.map(async (entry): Promise<JobSourceResult> => {
      try {
        const args = entry.configured
          ? resolveTemplate(entry.argumentsTemplate, { profile: effectiveProfile, limit: requestedLimit })
          : inferArguments(entry.inputSchema, effectiveProfile, requestedLimit);
        if (!entry.configured && args === undefined) {
          return {
            serverId: entry.server.id,
            tool: entry.tool,
            jobs: [],
            skipReason: 'The provider requires a search filter that does not support the current profile location or preferences.',
            fetchedCount: 0,
            normalizedCount: 0,
            roleMatchedCount: 0,
            locationMatchedCount: 0,
            connectionStatus: 'skipped',
          };
        }

        const toolArgs = entry.server.id === 'jobicy'
          ? {
              ...(args ?? {}),
              geo: resolveJobicyGeo(effectiveProfile),
              count: Math.min(200, requestedLimit),
            }
          : args ?? {};
        const inferredCountry = inferCountry(effectiveProfile);
        const sourceArgs = entry.server.id === 'remoteok'
          ? {
              ...(toolArgs ?? {}),
              query: effectiveProfile.jobTitle,
              location: effectiveProfile.location,
              limit: Math.min(100, requestedLimit),
            }
          : entry.server.id === 'mcp-jobspy-speedyapply'
            ? {
                ...(toolArgs ?? {}),
                results_wanted: Math.min(50, Math.max(10, requestedLimit)),
                ...(effectiveProfile.remote === true ? { is_remote: true } : {}),
              }
            : entry.server.id === 'himalayas-mcp'
              ? {
                  ...(toolArgs ?? {}),
                  ...(inferredCountry ? { country: inferredCountry } : {}),
                  page: 1,
                }
              : entry.server.id === 'aidevboard'
                ? {
                    ...(toolArgs ?? {}),
                    ...(effectiveProfile.remote === true ? { workplace: 'remote' } : {}),
                  }
                : toolArgs;
        const enhancedSourceArgs = entry.server.id === 'serper-search' && titleVariants.length > 0
          ? { ...sourceArgs, titleVariants }
          : sourceArgs;
        const result = entry.server.id === 'jobicy'
          ? await this.callJobicyWithCache(entry.server.id, entry.tool, enhancedSourceArgs)
          : await this.mcpRegistry.callTool(entry.server.id, entry.tool, enhancedSourceArgs);
        const searchId = extractSearchId(result);
        const parsedJobs = entry.server.id === 'jobdatalake' ? parseJobDataLakeSearchResult(result) : parseMcpJobResult(result);
        const rawJobs = parsedJobs.map((raw) => {
          if (!searchId || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
          return { ...(raw as Record<string, unknown>), search_id: searchId };
        });
        const normalizedJobs = rawJobs
          .map((raw) => normalizeJob(raw, resolveSourceId(entry.server.id, raw, entry.tool), effectiveProfile))
          .filter((job): job is NormalizedJob => Boolean(job));
        const preparedJobs = normalizedJobs.map((job) => {
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
          if (entry.server.id === 'serper-search' && typeof job.raw?.applicationUrl === 'string') {
            return { ...job, applicationUrl: job.raw.applicationUrl };
          }
          if (['jobicy', 'arbeitnow', 'workingnomads', 'himalayas', 'adzuna', 'jooble', 'remotive', 'weworkremotely', 'greenhouse', 'lever', 'ashby', 'serper-search'].includes(entry.server.id)) {
            return { ...job, applicationUrl: undefined };
          }
          return job;
        });
        const roleMatchedJobs = preparedJobs
          .filter((job) => matchesJobTitle(job.title, job.raw, effectiveProfile.jobTitle, effectiveProfile.experienceYears));
        const jobs = roleMatchedJobs.filter((job) => matchesJobLocation(job, effectiveProfile));
        return {
          serverId: entry.server.id,
          tool: entry.tool,
          jobs,
          report: parseSearchReport(result, entry.server.id),
          fetchedCount: rawJobs.length,
          normalizedCount: normalizedJobs.length,
          roleMatchedCount: roleMatchedJobs.length,
          locationMatchedCount: jobs.length,
          connectionStatus: 'searched',
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn('Job discovery from ' + entry.server.id + '/' + entry.tool + ' failed: ' + message);
        return {
          serverId: entry.server.id,
          tool: entry.tool,
          jobs: [],
          error: message,
          fetchedCount: 0,
          normalizedCount: 0,
          roleMatchedCount: 0,
          locationMatchedCount: 0,
          connectionStatus: 'search-error',
        };
      }
    }));
    const searchableServerIds = new Set(servers.map((entry) => entry.server.id));
    const unavailableSources: JobSourceResult[] = this.mcpRegistry.getStatuses()
      .filter((status) => status.enabled)
      .filter((status) => serverIds === undefined || serverIds.includes(status.id))
      .filter((status) => !searchableServerIds.has(status.id))
      .map((status) => ({
        serverId: status.id,
        tool: '',
        jobs: [],
        error: status.connected
          ? 'MCP is connected but exposes no recognized job-search tool.'
          : status.error ?? 'MCP server is not connected.',
        fetchedCount: 0,
        normalizedCount: 0,
        roleMatchedCount: 0,
        locationMatchedCount: 0,
        connectionStatus: status.connected ? 'no-search-tool' : 'disconnected',
      }));
    sourceResults.push(...unavailableSources);

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
      const sourceKey = serverId + ':' + job.source;
      const sourceTargets = detailTargetsBySource.get(sourceKey) ?? [];
      if (sourceTargets.length < 3) {
        sourceTargets.push(job);
        detailTargetsBySource.set(sourceKey, sourceTargets);
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
      const providerId = resolveSourceId(sourceResult.serverId, {}, sourceResult.tool);
      const requested = detailTargetsBySource.get(sourceResult.serverId + ':' + providerId) ?? [];
      const providerDetails = detailResults.filter((result) => result.serverId === sourceResult.serverId && result.job.source === providerId);
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
      sourceCount: new Set(sourceResults.map((entry) => entry.serverId)).size,
      jobs,
      sources: sourceResults.map((entry) => ({
        serverId: entry.serverId,
        tool: entry.tool,
        found: entry.jobs.length,
        fetchedCount: entry.fetchedCount,
        normalizedCount: entry.normalizedCount,
        roleMatchedCount: entry.roleMatchedCount,
        locationMatchedCount: entry.locationMatchedCount,
        connectionStatus: entry.connectionStatus,
        error: entry.error,
        report: entry.report,
        detailsRequested: entry.detailsRequested,
        detailsFetched: entry.detailsFetched,
        detailTool: entry.detailTool,
        skipReason: entry.skipReason,
      })),
      searchReport: sourceResults.flatMap((entry) => entry.report ? [entry.report] : []),
      backendSync,
      orchestration: {
        connectedMcpServers: this.mcpRegistry.getConnectedServerIds().length,
        connectedSearchTools: servers.length,
        executedSearchTools: sourceResults.filter((entry) => entry.connectionStatus === 'searched').length,
        queryPlanner: titleVariants.length > 0 ? 'llm-assisted' : 'deterministic',
        llmTitleExpansionUsed: titleVariants.length > 0,
        titleVariants,
      },
    };
  }


  private async enrichJobDetails(job: NormalizedJob, serverId: string | undefined, profile: JobProfile): Promise<{ job: NormalizedJob; serverId?: string; fetched: boolean; tool?: string }> {
    if (!serverId) return { job, fetched: false };
    const tools = this.mcpRegistry.getToolCatalog(serverId).flatMap((entry) => entry.tools);
    const detailTool = serverId === 'openings-mcp'
      ? tools.find((tool) => tool.name.startsWith(job.source + '_') && isJobDetailTool(tool.name))
      : tools.find((tool) => isJobDetailTool(tool.name));
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
    const cacheKey = JSON.stringify({ serverId, tool, query: args.query ?? args.tag, geo: args.geo, count: args.count ?? args.limit });
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



export function parseJobDataLakeSearchResult(result: unknown): unknown[] {
  const structuredJobs = parseMcpJobResult(result);
  if (structuredJobs.length > 0) return structuredJobs;
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

export function parseJobDataLakeDetailResult(result: unknown): unknown[] {
  const structuredDetails = parseMcpJobResult(result);
  if (structuredDetails.length > 0) return structuredDetails;
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

export function extractSearchId(value: unknown, depth = 0): string | undefined {
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
  const companyRecord = raw.company && typeof raw.company === 'object' ? raw.company as Record<string, unknown> : {};
  const companySlug = raw.company_slug ?? raw.companySlug ?? companyRecord.slug;
  const jobId = raw.id ?? raw.jobId ?? raw.job_id ?? raw.jobKey ?? raw.job_key ?? raw.job_handle ?? raw.jobHandle ?? raw.key ?? raw.slug ?? job.sourceJobId;
  const jobSlug = raw.job_slug ?? raw.jobSlug ?? raw.slug ?? job.sourceJobId ?? jobId;
  const searchId = raw.search_id ?? raw.searchId ?? raw.searchID;
  const country = raw.country ?? raw.country_name ?? profile.countries?.[0] ?? inferCountry(profile);
  const args: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const [name, metadata] of Object.entries(properties)) {
    const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    let value: unknown;
    if (compact === 'searchid' || compact === 'searchidentifier') value = searchId;
    else if (compact === 'companyslug') value = companySlug;
    else if (compact === 'jobslug') value = jobSlug;
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

function resolveSourceId(serverId: string, raw: unknown, toolName?: string): string {
  if (serverId === 'openings-mcp' && toolName) {
    const provider = /^([a-z0-9]+)_search_jobs$/i.exec(toolName);
    if (provider) return provider[1].toLowerCase();
  }
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

type InputSchemaProperty = {
  type?: string;
  description?: string;
  enum?: unknown[];
  pattern?: string;
  items?: {
    type?: string;
    enum?: unknown[];
    pattern?: string;
  };
};

type InputSchema = {
  properties?: Record<string, InputSchemaProperty>;
  required?: string[];
};

type CountryCode = {
  alpha2: string;
  alpha3: string;
  names: string[];
};

const COUNTRY_CODES: CountryCode[] = [
  { alpha2: 'in', alpha3: 'IND', names: ['india', 'bengaluru', 'bangalore', 'delhi', 'noida', 'gurugram', 'gurgaon', 'mumbai', 'hyderabad', 'chennai', 'pune', 'kolkata'] },
  { alpha2: 'us', alpha3: 'USA', names: ['united states', 'usa', 'america', 'new york', 'san francisco', 'california', 'texas', 'seattle', 'boston', 'chicago', 'austin', 'los angeles'] },
  { alpha2: 'gb', alpha3: 'GBR', names: ['united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales', 'london', 'manchester'] },
  { alpha2: 'de', alpha3: 'DEU', names: ['germany', 'berlin', 'munich', 'frankfurt', 'hamburg'] },
  { alpha2: 'ca', alpha3: 'CAN', names: ['canada', 'toronto', 'vancouver', 'montreal', 'calgary', 'ottawa'] },
  { alpha2: 'au', alpha3: 'AUS', names: ['australia', 'sydney', 'melbourne', 'perth', 'brisbane'] },
  { alpha2: 'sg', alpha3: 'SGP', names: ['singapore'] },
  { alpha2: 'jp', alpha3: 'JPN', names: ['japan', 'tokyo', 'osaka', 'yokohama'] },
  { alpha2: 'fr', alpha3: 'FRA', names: ['france', 'paris', 'lyon'] },
  { alpha2: 'nl', alpha3: 'NLD', names: ['netherlands', 'amsterdam', 'rotterdam'] },
  { alpha2: 'ie', alpha3: 'IRL', names: ['ireland', 'dublin', 'cork'] },
  { alpha2: 'nz', alpha3: 'NZL', names: ['new zealand', 'auckland', 'wellington'] },
  { alpha2: 'ae', alpha3: 'ARE', names: ['united arab emirates', 'uae', 'dubai', 'abu dhabi'] },
  { alpha2: 'pk', alpha3: 'PAK', names: ['pakistan', 'karachi', 'lahore', 'islamabad'] },
  { alpha2: 'bd', alpha3: 'BGD', names: ['bangladesh', 'dhaka'] },
  { alpha2: 'za', alpha3: 'ZAF', names: ['south africa', 'johannesburg', 'cape town'] },
  { alpha2: 'br', alpha3: 'BRA', names: ['brazil', 'sao paulo', 'rio de janeiro'] },
  { alpha2: 'es', alpha3: 'ESP', names: ['spain', 'madrid', 'barcelona'] },
  { alpha2: 'it', alpha3: 'ITA', names: ['italy', 'rome', 'milan'] },
  { alpha2: 'ch', alpha3: 'CHE', names: ['switzerland', 'zurich', 'geneva'] },
  { alpha2: 'se', alpha3: 'SWE', names: ['sweden', 'stockholm'] },
  { alpha2: 'no', alpha3: 'NOR', names: ['norway', 'oslo'] },
  { alpha2: 'dk', alpha3: 'DNK', names: ['denmark', 'copenhagen'] },
  { alpha2: 'pl', alpha3: 'POL', names: ['poland', 'warsaw', 'krakow'] },
  { alpha2: 'my', alpha3: 'MYS', names: ['malaysia', 'kuala lumpur'] },
  { alpha2: 'ph', alpha3: 'PHL', names: ['philippines', 'manila'] },
  { alpha2: 'id', alpha3: 'IDN', names: ['indonesia', 'jakarta'] },
  { alpha2: 'th', alpha3: 'THA', names: ['thailand', 'bangkok'] },
  { alpha2: 'vn', alpha3: 'VNM', names: ['vietnam', 'hanoi', 'ho chi minh'] },
  { alpha2: 'hk', alpha3: 'HKG', names: ['hong kong'] },
];

function normalizeSchemaToken(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function profileCountries(profile: JobProfile): CountryCode[] {
  const globalLocation = /^(worldwide|global|anywhere|all countries|all locations)$/i.test(profile.location ?? '');
  const locationText = normalizeSchemaToken(globalLocation ? '' : profile.location);
  const countryFromLocation = COUNTRY_CODES.filter((country) =>
    country.names.some((name) => locationText.includes(normalizeSchemaToken(name))),
  );
  if (countryFromLocation.length > 0) return countryFromLocation;

  const countriesText = normalizeSchemaToken((profile.countries ?? [])
    .filter((country) => !/^(worldwide|global|anywhere|all countries|all locations)$/i.test(country))
    .join(' '));
  return COUNTRY_CODES.filter((country) =>
    country.names.some((name) => countriesText.includes(normalizeSchemaToken(name))),
  );
}

function isAlpha2CountryProperty(metadata: InputSchemaProperty): boolean {
  return /alpha[- ]?2|two[- ]letter|two letter/i.test(metadata.description ?? '')
    || /\{2\}/.test(metadata.pattern ?? '');
}

function isAlpha3CountryProperty(metadata: InputSchemaProperty): boolean {
  return /alpha[- ]?3|three[- ]letter|three letter/i.test(metadata.description ?? '')
    || /\{3\}/.test(metadata.pattern ?? '');
}

function resolveEnumOption(candidate: string, options: unknown[], propertyName: string, description: string): string | undefined {
  const normalized = normalizeSchemaToken(candidate);
  const direct = options.find((option) => typeof option === 'string' && normalizeSchemaToken(option) === normalized);
  if (typeof direct === 'string') return direct;

  const field = propertyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const employmentFilter = /^(jobtype|employmenttype|employmenttypes|scheduletype)$/.test(field)
    && !/(job level|seniority|career level|experience level)/i.test(description);
  if (!employmentFilter) return undefined;

  const employmentAliases: Record<string, string[]> = {
    fulltime: ['fulltime', 'regular'],
    parttime: ['parttime'],
    contract: ['contract'],
    internship: ['internship', 'intern'],
    intern: ['intern', 'internship'],
    temporary: ['temporary'],
    freelance: ['freelance'],
    volunteer: ['volunteer'],
    fellowship: ['fellowship'],
  };
  const accepted = new Set(employmentAliases[normalized] ?? [normalized]);
  const option = options.find((item) => typeof item === 'string' && accepted.has(normalizeSchemaToken(item)));
  return typeof option === 'string' ? option : undefined;
}

function resolveLocationEnum(options: unknown[], profile: JobProfile, propertyName: string): string | undefined {
  const locationIsGlobal = /^(worldwide|global|anywhere|all countries|all locations)$/i.test(profile.location ?? '');
  const countries = profileCountries(profile);
  const normalizedProperty = propertyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (
    normalizedProperty === 'area'
    && (!locationIsGlobal || countries.length === 1)
    && countries.length === 1
    && countries[0].alpha2 === 'in'
  ) {
    const otherAsia = options.find((option) => typeof option === 'string' && normalizeSchemaToken(option) === 'otherasia');
    if (typeof otherAsia === 'string') return otherAsia;
  }

  if (locationIsGlobal && countries.length !== 1) return undefined;
  const candidates = locationIsGlobal
    ? [countries[0]?.names[0] ?? '']
    : [profile.location ?? '', ...(countries.length === 1 ? [countries[0].names[0]] : [])].filter(Boolean);
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeSchemaToken(candidate);
    const match = options.find((option) => typeof option === 'string'
      && normalizeSchemaToken(option) === normalizedCandidate);
    if (typeof match === 'string') return match;
    const suffixMatch = options.find((option) => typeof option === 'string'
      && normalizeSchemaToken(option).endsWith(normalizedCandidate)
      && normalizedCandidate.length >= 4);
    if (typeof suffixMatch === 'string') return suffixMatch;
  }
  return undefined;
}

function schemaCompatibleValue(
  value: unknown,
  metadata: InputSchemaProperty,
  propertyName: string,
  profile: JobProfile,
): unknown {
  if (value === undefined || value === null) return undefined;
  const options = metadata.enum ?? metadata.items?.enum;
  const itemPattern = metadata.items?.pattern;
  if (metadata.type === 'array' || Array.isArray(value)) {
    const values = Array.isArray(value) ? value : [value];
    let accepted = values;
    if (options?.length) {
      accepted = values.map((item) => resolveEnumOption(String(item), options, propertyName, metadata.description ?? '')).filter((item): item is string => Boolean(item));
    } else if (itemPattern) {
      let pattern: RegExp;
      try { pattern = new RegExp(itemPattern); } catch { return undefined; }
      accepted = values.filter((item) => pattern.test(String(item)));
    }
    return accepted.length > 0 ? accepted : undefined;
  }

  if (metadata.type === 'string' && Array.isArray(value)) value = value.join(', ');
  if (typeof value === 'string' && options?.length) {
    const match = resolveEnumOption(value, options, propertyName, metadata.description ?? '');
    return match;
  }
  if (typeof value === 'string' && metadata.pattern) {
    let pattern: RegExp;
    try { pattern = new RegExp(metadata.pattern); } catch { return undefined; }
    if (!pattern.test(value)) return undefined;
  }
  if (metadata.type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) return Math.floor(value);
  if (metadata.type === 'number' && typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (metadata.type === 'boolean' && typeof value !== 'boolean') return undefined;
  return value;
}

export function inferArguments(schemaValue: unknown, profile: JobProfile, limit: number): Record<string, unknown> | undefined {
  if (!schemaValue || typeof schemaValue !== 'object') return undefined;
  const schema = schemaValue as InputSchema;
  const properties = schema.properties ?? {};
  if (Object.keys(properties).length === 0) return undefined;
  const result: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const [name, metadata] of Object.entries(properties)) {
    const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const description = metadata.description ?? '';
    let value: unknown;
    if (/^(q|kw|query|querytext|keyword|keywords|search|searchtext|searchterm|searchquery|term|jobtitle|title|position|role|job|jobname)$/.test(compact)) {
      value = /s$/.test(compact) && metadata.type === 'array'
        ? [profile.jobTitle, ...(profile.keywords ?? [])]
        : [profile.jobTitle, ...(profile.keywords ?? [])].filter(Boolean).join(' ');
    } else if (/^(loc|location|locationname|city|cityname|geo|geography|place|joblocation|preferredlocation)$/.test(compact)) {
      const country = inferCountry(profile);
      const isCityField = /^(city|cityname)$/.test(compact);
      const requestedLocation = profile.location ?? profile.countries?.join(', ');
      value = isCityField
        ? requestedLocation?.split(',')[0]?.trim()
        : requestedLocation;
      if (metadata.enum?.length) value = resolveLocationEnum(metadata.enum, profile, name);
      if (metadata.type === 'string' && isAlpha2CountryProperty(metadata) && country) value = profileCountries(profile)[0]?.alpha2;
    } else if (compact === 'area') {
      value = metadata.enum?.length ? resolveLocationEnum(metadata.enum, profile, name) : undefined;
    } else if (compact === 'countries') {
      const countries = profileCountries(profile);
      if (isAlpha3CountryProperty(metadata)) {
        value = countries.length === 1 ? [countries[0].alpha3] : undefined;
      } else if (isAlpha2CountryProperty(metadata) || /alpha[- ]?2/i.test(description)) {
        value = countries.length ? countries.map((country) => country.alpha2).join(',') : undefined;
      } else {
        value = metadata.type === 'array' ? profile.countries : profile.countries?.join(', ');
      }
    } else if (/^(country|countryname|countrycode)$/.test(compact)) {
      const country = inferCountry(profile);
      const countries = profileCountries(profile);
      if (isAlpha3CountryProperty(metadata)) value = countries.length === 1 ? countries[0].alpha3 : undefined;
      else if (isAlpha2CountryProperty(metadata)) value = countries.length === 1 ? countries[0].alpha2 : undefined;
      else value = country ?? (countries.length === 1 ? profile.countries?.[0] ?? country : undefined);
    } else if (/^(skills|skill|technologies|techstack)$/.test(compact)) {
      value = metadata.type === 'array' ? profile.skills : profile.skills?.join(', ');
    } else if (/^(experience|experienceyears|minexperience|yearsofexperience|experiencelevel)$/.test(compact)) {
      value = profile.experienceYears;
    } else if (/^(salarymin|minsalary|minimumsalary|salaryfrom)$/.test(compact)) {
      value = profile.salaryMin;
    } else if (/^(salarymax|maxsalary|maximumsalary|salaryto)$/.test(compact)) {
      value = profile.salaryMax;
    } else if (/^(currency|salarycurrency)$/.test(compact)) {
      value = profile.salaryCurrency;
    } else if (/^(remote|remoteonly|isremote)$/.test(compact)) {
      value = metadata.type === 'boolean' ? profile.remote : profile.remote ? 'Remote' : undefined;
    } else if (/^(workplace|workplacetype)$/.test(compact)) {
      value = profile.remote ? 'Remote' : undefined;
    } else if (/^(jobtype|employmenttype|employmenttypes|scheduletype)$/.test(compact)) {
      if (!/(job level|seniority|career level|experience level)/i.test(description)) {
        value = metadata.type === 'array' ? profile.employmentTypes : profile.employmentTypes?.[0];
        if (compact === 'scheduletype' && typeof value === 'string') {
          value = value.replace(/\bfull[-_ ]?time\b/i, 'Full-Time').replace(/\bpart[-_ ]?time\b/i, 'Part-Time');
        }
      }
    } else if (/^(limit|count|n|resultsWanted|pageSize|maxresults|maxrows|numresults|resultlimit|perpage|pagesize|take)$/.test(compact)) {
      value = limit;
    } else if (/^(page|start|offset)$/.test(compact)) {
      value = compact === 'page' ? 1 : 0;
    } else if (/^(userId|userid)$/.test(compact)) {
      value = profile.userId;
    }

    const compatible = schemaCompatibleValue(value, metadata, name, profile);
    if (compatible !== undefined) result[name] = compatible;
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
