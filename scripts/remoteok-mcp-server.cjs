#!/usr/bin/env node
const readline = require('node:readline');

const API_URL = 'https://remoteok.com/api';
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache = { expiresAt: 0, jobs: [] };
let inFlight;

const tools = [{
  name: 'search_jobs',
  description: 'Search current Remote OK public remote-job listings. Results preserve each canonical Remote OK listing URL and source attribution.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Target job title or keywords' },
      location: { type: 'string', description: 'Preferred city, country, region, remote, or worldwide' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    required: ['query']
  }
}];

function text(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' ');
  return '';
}

function tokens(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9+#.]+/).filter((part) => part.length > 2);
}

function regionFor(value) {
  const normalized = String(value || '').toLowerCase();
  if (/\b(latin america|latam|south america|central america|brazil|argentina|mexico|colombia|chile|peru)\b/.test(normalized)) return 'latin-america';
  if (/\b(india|bengaluru|bangalore|delhi|mumbai|hyderabad|chennai|pune|kolkata|asia|apac|singapore|australia|japan|new zealand|philippines|pakistan|nepal|sri lanka|indonesia|thailand|vietnam|hong kong|malaysia)\b/.test(normalized)) return 'apac';
  if (/\b(europe|united kingdom|\buk\b|london|germany|berlin|france|paris|netherlands|amsterdam|ireland|dublin|spain|italy|poland|sweden|norway|finland|portugal|switzerland|austria|belgium|denmark)\b/.test(normalized)) return 'europe';
  if (/\b(usa|united states|america|new york|san francisco|california|texas|seattle|austin|chicago|boston|los angeles|canada|toronto|vancouver|north america)\b/.test(normalized)) return 'north-america';
  return undefined;
}

function isGlobalLocation(value) {
  return /\b(worldwide|anywhere|global|all countries|work from anywhere|remote worldwide)\b/i.test(String(value || ''));
}

function jobText(job) {
  return [
    job.position, job.title, job.description, job.tags,
    job.company, job.company_name
  ].map(text).join(' ').toLowerCase();
}

function matchesQuery(job, query) {
  const queryTokens = tokens(query).filter((term) => !['the', 'and', 'for', 'with', 'senior', 'junior', 'lead', 'staff', 'principal', 'remote', 'full', 'time', 'developer', 'engineer', 'software'].includes(term));
  const candidates = queryTokens.length > 0 ? queryTokens : tokens(query);
  const searchable = jobText(job);
  return candidates.length === 0 || candidates.some((term) => searchable.includes(term));
}

function matchesLocation(job, requested) {
  const location = String(requested || '').trim();
  if (!location || /^(remote|worldwide|global|anywhere|all locations|all countries)$/i.test(location)) return true;

  const structuredLocation = [job.location, job.location_country, job.region].map(text).join(' ').trim();
  if (isGlobalLocation(structuredLocation)) return true;

  const requestedTerms = tokens(location);
  const structuredLower = structuredLocation.toLowerCase();
  if (requestedTerms.some((term) => structuredLower.includes(term))) return true;

  const requestedRegion = regionFor(location);
  const listedRegion = regionFor(structuredLocation);
  if (requestedRegion && listedRegion) return requestedRegion === listedRegion;
  if (structuredLocation) return false;

  const description = text(job.description);
  if (isGlobalLocation(description)) return true;
  const restriction = description.match(/(?:based in|based out of|located in|must be (?:located|based|resident) in|residing in|residing within|candidates? (?:must|should) be (?:located|based) in|only available in|available only in|position is restricted to)\s+([^.<\n]{2,70})/i);
  const restrictedRegion = restriction ? regionFor(restriction[1]) : undefined;
  if (requestedRegion && restrictedRegion) return requestedRegion === restrictedRegion;
  if (requestedRegion && /\b(latin america|latam|south america|central america|north america|europe|apac|asia|united states|usa|canada|india|australia|united kingdom|uk)\b/i.test(description)) {
    const mentionedRegion = regionFor(description);
    if (mentionedRegion && mentionedRegion !== requestedRegion) return false;
  }

  return true;
}

async function getJobs() {
  if (cache.expiresAt > Date.now()) return cache.jobs;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const response = await fetch(API_URL, {
      headers: {
        accept: 'application/json',
        'user-agent': 'NvoidJobAgent/1.0 (+https://jobkar.in)'
      },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error('Remote OK feed returned HTTP ' + response.status);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error('Remote OK feed returned an unexpected response.');
    const jobs = payload.filter((job) => job && typeof job === 'object' && !job.legal_notice && !job.legal_notice_url && (job.position || job.title) && job.url);
    cache = { jobs, expiresAt: Date.now() + CACHE_TTL_MS };
    return jobs;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}

async function searchJobs(args) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('A job title or search query is required.');
  const location = String(args.location || 'Worldwide').trim();
  const allJobs = await getJobs();
  const matching = allJobs.filter((job) => matchesQuery(job, query) && matchesLocation(job, location));

  const limitNumber = Number(args.limit);
  const limit = Number.isFinite(limitNumber) ? Math.min(100, Math.max(1, Math.floor(limitNumber))) : 30;
  return matching.slice(0, limit).map((job) => ({
    id: text(job.id || job.slug),
    title: text(job.position || job.title),
    company: text(job.company || job.company_name),
    location: text(job.location || job.location_country || 'Remote · eligibility not stated'),
    country: text(job.location_country),
    description: text(job.description),
    tags: Array.isArray(job.tags) ? job.tags : [],
    employmentType: text(job.job_type || job.employment_type),
    workMode: 'Remote',
    salaryMin: typeof job.salary_min === 'number' ? job.salary_min : undefined,
    salaryMax: typeof job.salary_max === 'number' ? job.salary_max : undefined,
    salaryCurrency: text(job.salary_currency) || undefined,
    postedAt: text(job.date || job.epoch),
    url: text(job.url),
    apply_url: text(job.apply_url) || undefined,
    source: 'remoteok'
  }));
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  const id = message.id;
  const hasId = id !== undefined && id !== null;
  if (!hasId || message.method.startsWith('notifications/')) return;

  if (message.method === 'initialize') {
    respond(id, {
      protocolVersion: message.params && typeof message.params.protocolVersion === 'string' ? message.params.protocolVersion : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'nvoid-remoteok-source', version: '1.0.0' }
    });
    return;
  }

  if (message.method === 'ping') {
    respond(id, {});
    return;
  }

  if (message.method === 'tools/list') {
    respond(id, { tools });
    return;
  }

  if (message.method === 'tools/call') {
    if (message.params?.name !== 'search_jobs') {
      respondError(id, -32602, 'Unknown tool: ' + String(message.params?.name));
      return;
    }

    try {
      const args = message.params?.arguments && typeof message.params.arguments === 'object' ? message.params.arguments : {};
      const jobs = await searchJobs(args);
      const result = { jobs, source: 'Remote OK', returnedCount: jobs.length, cachedForSeconds: 3600 };
      respond(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      respondError(id, -32000, messageText);
    }
    return;
  }

  respondError(id, -32601, 'Unsupported method: ' + message.method);
}

function start() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (!line.trim()) return;
    try {
      void handle(JSON.parse(line)).catch((error) => {
        process.stderr.write('Remote OK MCP request failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
      });
    } catch {
      process.stderr.write('Ignored invalid JSON on Remote OK MCP input.\n');
    }
  });
}

if (require.main === module) start();

module.exports = { matchesLocation, matchesQuery, regionFor };
