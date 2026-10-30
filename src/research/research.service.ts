import { Injectable, Logger } from '@nestjs/common';
import { AiAgentService, type PlannedResearchCall } from '../common/ai-agent.service';
import { McpRegistryService } from '../mcp/mcp-registry.service';
import type { ResearchRunDto } from './research.dto';

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
};

type ResearchTool = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

type ResearchToolEntry = {
  serverId: string;
  serverName: string;
  tool: ResearchTool;
};

type ResearchCallPlan = PlannedResearchCall & {
  reason: string;
};

type ResearchCallResult = {
  serverId: string;
  serverName: string;
  toolName: string;
  reason: string;
  status: 'success' | 'failed';
  durationMs: number;
  recordsReturned: number;
  providerReport?: Record<string, unknown>;
  error?: string;
};

type ResearchRecord = {
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  title?: string;
  url?: string;
  data: Record<string, unknown>;
};

const MUTATING_TOOL_PATTERN = /(^|[_\s-])(create|update|delete|remove|insert|send|submit|apply|publish|post|purchase|refund|charge|deploy|restart|start|stop|write|mutate|grant|revoke|invite|approve|modify|edit|upload|download|sync|execute)([_\s-]|$)/i;
const READ_TOOL_PATTERN = /(^|[_\s-])(search|find|list|query|get|fetch|read|lookup|retrieve|describe|report|analytics|metrics|browse|discover|inspect|enumerate|scan|view|show)([_\s-]|$)/i;
const COLLECTION_KEYS = new Set([
  'records', 'items', 'results', 'data', 'jobs', 'rows', 'entries', 'companies',
  'contacts', 'leads', 'projects', 'documents', 'messages', 'events', 'opportunities',
  'vacancies', 'listings', 'people', 'users', 'tasks', 'issues', 'repositories',
]);

@Injectable()
export class ResearchService {
  private readonly logger = new Logger(ResearchService.name);

  constructor(
    private readonly registry: McpRegistryService,
    private readonly ai: AiAgentService,
  ) {}

  listTools() {
    const statuses = this.registry.getStatuses();
    const catalog = this.registry.getToolCatalog() as Array<{
      serverId: string;
      serverName: string;
      tools: ResearchTool[];
    }>;
    const available = catalog.flatMap((server) => server.tools
      .filter((tool) => isReadOnlyResearchTool(tool))
      .map((tool) => ({
        serverId: server.serverId,
        serverName: server.serverName,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        safety: tool.annotations?.readOnlyHint === true ? 'mcp-readonly-annotated' : 'read-operation-name-verified',
      })));
    return {
      generatedAt: new Date().toISOString(),
      connectedServers: statuses.filter((server) => server.connected).length,
      configuredServers: statuses.length,
      servers: statuses,
      availableReadOnlyTools: available,
      availableReadOnlyToolCount: available.length,
    };
  }

  async run(dto: ResearchRunDto) {
    const query = dto.query.trim();
    const maxRecords = Math.min(1000, Math.max(1, dto.maxRecords ?? 100));
    const maxTools = Math.min(40, Math.max(1, dto.maxTools ?? 20));
    const statuses = this.registry.getStatuses();
    const statusById = new Map<string, (typeof statuses)[number]>();
    for (const status of statuses) statusById.set(status.id, status);
    const selectedServers = new Set(dto.serverIds ?? []);
    const connectedCatalog = this.registry.getToolCatalog() as Array<{
      serverId: string;
      serverName: string;
      tools: ResearchTool[];
    }>;
    const safeTools: ResearchToolEntry[] = connectedCatalog
      .filter((server) => selectedServers.size === 0 || selectedServers.has(server.serverId))
      .flatMap((server) => server.tools
        .filter((tool) => isReadOnlyResearchTool(tool))
        .map((tool) => ({ serverId: server.serverId, serverName: server.serverName, tool })));

    const warnings: string[] = [];
    if (connectedCatalog.length === 0) warnings.push('No MCP servers are currently connected. Configure real MCP endpoints and credentials in the worker, then restart it.');
    if (safeTools.length === 0 && connectedCatalog.length > 0) warnings.push('Connected MCP servers expose no tools that can be safely identified as read-only research operations.');
    if (selectedServers.size > 0) {
      const missing = [...selectedServers].filter((id) => !connectedCatalog.some((server) => server.serverId === id));
      if (missing.length > 0) warnings.push('These requested server IDs are not connected or were not found: ' + missing.join(', '));
    }

    let planner: 'llm' | 'heuristic' = 'heuristic';
    let plans: ResearchCallPlan[] = [];
    let planningError: string | undefined;
    if (safeTools.length > 0 && this.ai.isEnabled()) {
      try {
        const proposed = await this.ai.planResearchCalls(
          query,
          safeTools.map((entry) => ({
            serverId: entry.serverId,
            serverName: entry.serverName,
            name: entry.tool.name,
            description: entry.tool.description,
            inputSchema: entry.tool.inputSchema,
          })),
          maxTools,
          maxRecords,
        );
        plans = validatePlannedCalls(proposed, safeTools, maxRecords, maxTools);
        if (plans.length > 0) planner = 'llm';
        else planningError = 'The AI planner did not produce any valid read-only tool calls; schema-based discovery was used instead.';
      } catch (error) {
        planningError = 'The AI planner failed; schema-based discovery was used instead: ' + messageOf(error);
        this.logger.warn(planningError);
      }
    } else if (!this.ai.isEnabled()) {
      warnings.push('LLM_API_KEY or LLM_MODEL is not configured. Research is running with schema-based query and argument matching, not AI planning.');
    }

    if (plans.length === 0) {
      plans = buildHeuristicPlan(query, safeTools, maxRecords, maxTools);
      planner = 'heuristic';
    }
    if (planningError) warnings.push(planningError);
    if (plans.length === 0 && safeTools.length > 0) {
      warnings.push('Read-only tools were discovered, but none had a schema that could be called safely using only the supplied research query and result limit.');
    }

    const executions = await runConcurrent(plans, 6, async (plan): Promise<{ call: ResearchCallResult; records: unknown[] }> => {
      const entry = safeTools.find((item) => item.serverId === plan.serverId && item.tool.name === plan.toolName);
      if (!entry || !isReadOnlyResearchTool(entry.tool)) {
        return {
          call: {
            serverId: plan.serverId,
            serverName: statusById.get(plan.serverId)?.name ?? plan.serverId,
            toolName: plan.toolName,
            reason: plan.reason,
            status: 'failed',
            durationMs: 0,
            recordsReturned: 0,
            error: 'Tool was not present in the verified read-only catalog.',
          },
          records: [],
        };
      }
      const started = Date.now();
      try {
        const raw = await this.registry.callTool(plan.serverId, plan.toolName, plan.arguments);
        const records = extractResearchRecords(raw);
        const root = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        const structured = root.structuredContent && typeof root.structuredContent === 'object'
          ? root.structuredContent as Record<string, unknown>
          : {};
        const providerReport = structured.searchReport && typeof structured.searchReport === 'object'
          ? boundValue(structured.searchReport) as Record<string, unknown>
          : undefined;
        return {
          call: {
            serverId: plan.serverId,
            serverName: entry.serverName,
            toolName: plan.toolName,
            reason: plan.reason,
            status: 'success',
            durationMs: Date.now() - started,
            recordsReturned: records.length,
            ...(providerReport ? { providerReport } : {}),
          },
          records,
        };
      } catch (error) {
        const errorText = messageOf(error).slice(0, 1000);
        this.logger.warn('Research call ' + plan.serverId + '/' + plan.toolName + ' failed: ' + errorText);
        return {
          call: {
            serverId: plan.serverId,
            serverName: entry.serverName,
            toolName: plan.toolName,
            reason: plan.reason,
            status: 'failed',
            durationMs: Date.now() - started,
            recordsReturned: 0,
            error: errorText,
          },
          records: [],
        };
      }
    });

    const calls = executions.map((result) => result.call);
    const rawRecords = executions.flatMap((result) => result.records);
    const unique = new Map<string, ResearchRecord>();
    let duplicatesRemoved = 0;
    let capReached = false;
    researchLoop: for (const execution of executions) {
      for (const value of execution.records) {
        const object = asRecord(value);
        if (!object) continue;
        const key = recordKey(object);
        if (unique.has(key)) {
          duplicatesRemoved += 1;
          continue;
        }
        if (unique.size >= maxRecords) {
          capReached = true;
          break researchLoop;
        }
        const tool = execution.call;
        const safeData = boundValue(object) as Record<string, unknown>;
        const title = stringField(object, ['title', 'name', 'company', 'subject', 'headline', 'label']);
        const url = stringField(object, ['url', 'jobUrl', 'job_url', 'href', 'permalink', 'link', 'website']);
        unique.set(key, {
          id: 'record-' + (unique.size + 1),
          serverId: tool.serverId,
          serverName: tool.serverName,
          toolName: tool.toolName,
          ...(title ? { title } : {}),
          ...(url && /^https?:\\/\\//i.test(url) ? { url } : {}),
          data: safeData,
        });
      }
    }
    if (capReached) {
      warnings.push('The unique-record cap was reached. Additional source records may exist but were not included in this response.');
    }

    const records = [...unique.values()];
    const perConnector = connectedCatalog
      .filter((server) => selectedServers.size === 0 || selectedServers.has(server.serverId))
      .map((server) => {
        const sourceCalls = calls.filter((call) => call.serverId === server.serverId);
        return {
          serverId: server.serverId,
          serverName: server.serverName,
          discoveredTools: server.tools.length,
          readOnlyTools: server.tools.filter(isReadOnlyResearchTool).length,
          callsSucceeded: sourceCalls.filter((call) => call.status === 'success').length,
          callsFailed: sourceCalls.filter((call) => call.status === 'failed').length,
          recordsReturned: sourceCalls.reduce((total, call) => total + call.recordsReturned, 0),
        };
      });

    return {
      query,
      generatedAt: new Date().toISOString(),
      planner,
      report: {
        connectedServers: connectedCatalog.length,
        toolsDiscovered: connectedCatalog.reduce((total, server) => total + server.tools.length, 0),
        readOnlyToolsDiscovered: safeTools.length,
        plannedCalls: plans.length,
        successfulCalls: calls.filter((call) => call.status === 'success').length,
        failedCalls: calls.filter((call) => call.status === 'failed').length,
        rawRecords: rawRecords.length,
        uniqueRecords: records.length,
        duplicatesRemoved,
        maxRecords,
        truncated: capReached,
        perConnector,
      },
      calls,
      records,
      warnings,
    };
  }
}

export function isReadOnlyResearchTool(tool: ResearchTool): boolean {
  const normalizedName = tool.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  const identity = (normalizedName + ' ' + (tool.description ?? '')).trim();
  if (MUTATING_TOOL_PATTERN.test(normalizedName)) return false;
  if (tool.annotations?.destructiveHint === true || tool.annotations?.readOnlyHint === false) return false;
  if (tool.annotations?.readOnlyHint === true) return true;
  return READ_TOOL_PATTERN.test(normalizedName);
}

export function inferResearchArguments(
  query: string,
  schemaValue: unknown,
  maxRecords: number,
): Record<string, unknown> | undefined {
  if (!schemaValue || typeof schemaValue !== 'object') return undefined;
  const schema = schemaValue as JsonSchema;
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const result: Record<string, unknown> = {};
  const location = query.match(/\b(?:in|near|around|within|based in|located in)\s+([^,;.!?]+)/i)?.[1]?.trim();

  for (const [name, property] of Object.entries(properties)) {
    const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    let value: unknown;
    if (/^(q|query|querytext|search|searchtext|searchterm|term|keyword|keywords|text|input|prompt|question|topic|subject|jobtitle|role|position)$/.test(compact)) {
      value = property.type === 'array' ? [query] : query;
    } else if (/^(limit|count|maxresults|maxrecords|pagesize|perpage|take|top|numresults|resultlimit)$/.test(compact)) {
      value = maxRecords;
    } else if (/^(location|city|region|geo|geography|place|country|countries)$/.test(compact) && location) {
      value = property.type === 'array' ? [location] : location;
    }
    if (value !== undefined) {
      if (property.enum && !property.enum.includes(value)) continue;
      result[name] = value;
    } else if (required.includes(name)) {
      return undefined;
    }
  }
  return result;
}

export function extractResearchRecords(raw: unknown): unknown[] {
  if (!raw || typeof raw !== 'object') return parseTextOrValue(raw);
  const root = raw as Record<string, unknown>;
  if (root.isError === true) return [];
  if (root.structuredContent !== undefined) {
    const records = collectRecords(root.structuredContent, 0);
    if (records.length > 0) return records;
  }
  if (Array.isArray(root.content)) {
    const records = root.content.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const block = item as Record<string, unknown>;
      if (typeof block.text === 'string') return parseTextOrValue(block.text);
      if (block.type === 'json') return collectRecords(block.json, 0);
      return [];
    });
    if (records.length > 0) return records;
  }
  return collectRecords(raw, 0);
}

function collectRecords(value: unknown, depth: number): unknown[] {
  if (depth > 8 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectRecords(item, depth + 1));
  if (typeof value === 'string') return parseTextOrValue(value);
  if (typeof value !== 'object') return [{ value }];
  const object = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(object)) {
    if (COLLECTION_KEYS.has(key.toLowerCase()) && Array.isArray(nested)) {
      return nested.flatMap((item) => collectRecords(item, depth + 1));
    }
  }
  for (const key of ['result', 'response', 'payload', 'output']) {
    if (object[key] && typeof object[key] === 'object') {
      const nested = collectRecords(object[key], depth + 1);
      if (nested.length > 0) return nested;
    }
  }
  if (object.data && typeof object.data === 'object') {
    const nested = collectRecords(object.data, depth + 1);
    if (nested.length > 0) return nested;
  }
  return [object];
}

function parseTextOrValue(value: unknown): unknown[] {
  if (typeof value !== 'string') return value === undefined ? [] : [{ value }];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return collectRecords(JSON.parse(trimmed) as unknown, 0);
    } catch {
      return [{ text: trimmed.slice(0, 12000) }];
    }
  }
  return [{ text: trimmed.slice(0, 12000) }];
}

function buildHeuristicPlan(
  query: string,
  tools: ResearchToolEntry[],
  maxRecords: number,
  maxTools: number,
): ResearchCallPlan[] {
  const queryTerms = tokenize(query);
  const candidates = tools.map((entry) => {
    const text = (entry.tool.name + ' ' + (entry.tool.description ?? '') + ' ' + entry.serverName).toLowerCase();
    const overlap = queryTerms.filter((term) => text.includes(term)).length;
    const normalizedName = entry.tool.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    const searchAction = READ_TOOL_PATTERN.test(normalizedName) ? 4 : 0;
    return { entry, score: overlap * 3 + searchAction };
  }).sort((a, b) => b.score - a.score || a.entry.serverId.localeCompare(b.entry.serverId));
  const counts = new Map<string, number>();
  const plans: ResearchCallPlan[] = [];
  for (const candidate of candidates) {
    if (plans.length >= maxTools) break;
    if (candidate.score === 0) continue;
    const serverCount = counts.get(candidate.entry.serverId) ?? 0;
    if (serverCount >= 3) continue;
    const args = inferResearchArguments(query, candidate.entry.tool.inputSchema, maxRecords);
    if (!args) continue;
    plans.push({
      serverId: candidate.entry.serverId,
      toolName: candidate.entry.tool.name,
      arguments: args,
      reason: 'Selected by read-only tool name, description, and query/schema matching.',
    });
    counts.set(candidate.entry.serverId, serverCount + 1);
  }
  return plans;
}

function validatePlannedCalls(
  proposed: PlannedResearchCall[],
  tools: ResearchToolEntry[],
  maxRecords: number,
  maxTools: number,
): ResearchCallPlan[] {
  const byId = new Map(tools.map((entry) => [entry.serverId + '/' + entry.tool.name, entry]));
  const selected = new Set<string>();
  const counts = new Map<string, number>();
  const result: ResearchCallPlan[] = [];
  for (const plan of proposed) {
    const key = plan.serverId + '/' + plan.toolName;
    const entry = byId.get(key);
    if (!entry || !isReadOnlyResearchTool(entry.tool) || selected.has(key)) continue;
    const count = counts.get(plan.serverId) ?? 0;
    if (count >= 4) continue;
    const args = validateArguments(plan.arguments, entry.tool.inputSchema, maxRecords);
    if (!args) continue;
    result.push({
      serverId: plan.serverId,
      toolName: plan.toolName,
      arguments: args,
      reason: (plan.reason || 'Selected by the research planner.').slice(0, 240),
    });
    selected.add(key);
    counts.set(plan.serverId, count + 1);
    if (result.length >= maxTools) break;
  }
  return result;
}

function validateArguments(
  proposed: Record<string, unknown>,
  schemaValue: unknown,
  maxRecords: number,
): Record<string, unknown> | undefined {
  if (!schemaValue || typeof schemaValue !== 'object') return undefined;
  const schema = schemaValue as JsonSchema;
  const properties = schema.properties ?? {};
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(proposed)) {
    const property = properties[key];
    if (!property || !isSchemaValue(value, property)) continue;
    if (property.enum && !property.enum.includes(value)) continue;
    args[key] = value;
  }
  for (const required of schema.required ?? []) {
    if (!(required in args)) return undefined;
  }
  for (const [key, value] of Object.entries(args)) {
    if (/^(limit|count|maxresults|maxrecords|pagesize|perpage|take|top|numresults|resultlimit)$/i.test(key) && typeof value === 'number') {
      args[key] = Math.min(maxRecords, Math.max(1, Math.floor(value)));
    }
  }
  return args;
}

function isSchemaValue(value: unknown, schema: JsonSchema): boolean {
  if (!schema.type) return true;
  if (schema.type === 'array') return Array.isArray(value) && (!schema.items || value.every((item) => isSchemaValue(item, schema.items!)));
  if (schema.type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (schema.type === 'integer') return Number.isInteger(value);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'string') return typeof value === 'string';
  return true;
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9+#.]+/).filter((term) => term.length > 2))].slice(0, 40);
}

function recordKey(record: Record<string, unknown>): string {
  const url = stringField(record, ['url', 'jobUrl', 'job_url', 'href', 'permalink', 'link']);
  if (url) return 'url:' + normalizeUrl(url);
  const id = stringField(record, ['id', '_id', 'uuid', 'jobId', 'job_id', 'recordId']);
  if (id) return 'id:' + id.toLowerCase();
  const email = stringField(record, ['email', 'emailAddress']);
  if (email) return 'email:' + email.toLowerCase();
  const title = stringField(record, ['title', 'name', 'subject', 'headline']);
  const company = stringField(record, ['company', 'companyName', 'organization', 'employer']);
  const location = stringField(record, ['location', 'city', 'country']);
  if (title || company) return 'text:' + [title, company, location].map((part) => (part ?? '').toLowerCase().trim()).join('|');
  return 'json:' + JSON.stringify(boundValue(record)).slice(0, 2000);
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().toLowerCase().replace(/\/$/, '');
  }
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 2000);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') return { text: value.slice(0, 12000) };
  if (value !== undefined && value !== null) return { value };
  return undefined;
}

function boundValue(value: unknown, depth = 0): unknown {
  if (depth > 7) return '[maximum nesting depth]';
  if (typeof value === 'string') return value.slice(0, 12000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => boundValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 100);
    const result = Object.fromEntries(entries.map(([key, item]) => [key.slice(0, 160), boundValue(item, depth + 1)]));
    const serialized = JSON.stringify(result);
    if (serialized.length > 50000) return { excerpt: serialized.slice(0, 50000), truncated: true };
    return result;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runConcurrent<T, R>(items: T[], concurrency: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
    }
  }));
  return results;
}
