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

function regionsFor(value) {
  const normalized = String(value || '').toLowerCase();
  const regions = [];
  if (/\b(latin america|latam|south america|central america|brazil|argentina|mexico|colombia|chile|peru)\b/.test(normalized)) regions.push('latin-america');
  if (/\b(india|bengaluru|bangalore|delhi|mumbai|hyderabad|chennai|pune|kolkata|asia|apac|singapore|australia|japan|new zealand|philippines|pakistan|nepal|sri lanka|indonesia|thailand|vietnam|hong kong|malaysia)\b/.test(normalized)) regions.push('apac');
  if (/\b(europe|united kingdom|\buk\b|london|germany|berlin|france|paris|netherlands|amsterdam|ireland|dublin|spain|italy|poland|sweden|norway|finland|portugal|switzerland|austria|belgium|denmark)\b/.test(normalized)) regions.push('europe');
  if (/\b(usa|united states|america|new york|san francisco|california|texas|seattle|austin|chicago|boston|los angeles|canada|toronto|vancouver|north america)\b/.test(normalized)) regions.push('north-america');
  if (/\b(middle east|uae|united arab emirates|dubai|saudi arabia|qatar|kuwait|bahrain|oman)\b/.test(normalized)) regions.push('middle-east');
  if (/\b(africa|south africa|nigeria|kenya|egypt|ghana)\b/.test(normalized)) regions.push('africa');
  return regions;
}

function regionFor(value) {
  return regionsFor(value)[0];
}

function countriesFor(value) {
  const s = normalizeLocation(value);
  const checks = [
    ['india', /\b(india|bengaluru|bangalore|delhi|delhi ncr|mumbai|hyderabad|chennai|pune|kolkata|noida|gurugram|gurgaon)\b/],
    ['australia', /\b(australia|sydney|melbourne|perth|brisbane|adelaide)\b/],
    ['new-zealand', /\b(new zealand|auckland|wellington)\b/],
    ['singapore', /\bsingapore\b/],
    ['japan', /\b(japan|tokyo|osaka)\b/],
    ['philippines', /\b(philippines|manila)\b/],
    ['pakistan', /\b(pakistan|karachi|lahore|islamabad)\b/],
    ['nepal', /\bnepal\b/],
    ['sri-lanka', /\b(sri lanka|colombo)\b/],
    ['indonesia', /\b(indonesia|jakarta)\b/],
    ['thailand', /\bthailand\b/],
    ['vietnam', /\bvietnam\b/],
    ['malaysia', /\bmalaysia\b/],
    ['hong-kong', /\bhong kong\b/],
    ['united-kingdom', /\b(united kingdom|uk|england|scotland|wales|london|manchester|birmingham)\b/],
    ['germany', /\b(germany|berlin|munich|frankfurt|hamburg)\b/],
    ['france', /\b(france|paris|lyon)\b/],
    ['netherlands', /\b(netherlands|amsterdam|rotterdam|utrecht)\b/],
    ['ireland', /\b(ireland|dublin|cork)\b/],
    ['spain', /\b(spain|madrid|barcelona)\b/],
    ['italy', /\b(italy|rome|milan)\b/],
    ['poland', /\b(poland|warsaw|krakow)\b/],
    ['sweden', /\bsweden\b/],
    ['norway', /\bnorway\b/],
    ['finland', /\bfinland\b/],
    ['portugal', /\b(portugal|lisbon)\b/],
    ['switzerland', /\b(switzerland|zurich|geneva)\b/],
    ['austria', /\baustria\b/],
    ['belgium', /\bbelgium\b/],
    ['denmark', /\bdenmark\b/],
    ['united-states', /\b(united states|usa|new york|san francisco|california|texas|seattle|austin|chicago|boston|los angeles)\b/],
    ['canada', /\b(canada|toronto|vancouver|montreal|calgary|ottawa|edmonton)\b/],
    ['brazil', /\b(brazil|sao paulo|rio de janeiro)\b/],
    ['mexico', /\bmexico\b/],
    ['argentina', /\bargentina\b/],
    ['colombia', /\bcolombia\b/],
    ['chile', /\bchile\b/],
    ['south-africa', /\b(south africa|johannesburg|cape town)\b/],
    ['nigeria', /\bnigeria\b/],
    ['kenya', /\bkenya\b/],
    ['egypt', /\begypt\b/],
    ['united-arab-emirates', /\b(united arab emirates|uae|dubai|abu dhabi)\b/],
    ['saudi-arabia', /\b(saudi arabia|riyadh|jeddah)\b/],
  ];
  return checks.filter(([, pattern]) => pattern.test(s)).map(([country]) => country);
}

function isExplicitGlobalEligibility(value) {
  return /\b(available worldwide|worldwide eligible|work from anywhere|remote from anywhere|remote worldwide|anywhere in the world|open to candidates worldwide|eligible in all countries|remote from any location)\b/i.test(String(value || ''));
}
function displayLocation(job) {
  const primary = text(job.location);
  const restriction = text(job.location_country || job.location_restrictions || job.locationRestrictions || job.allowedCountries || job.allowed_countries || job.countries);
  if (primary && !/^(remote|remote only|remote eligible|remote · eligibility not stated)$/i.test(primary)) return primary;
  if (restriction) return primary ? primary + ' · ' + restriction : restriction;
  if (isExplicitGlobalEligibility(job.description)) return 'Worldwide';
  return primary || 'Remote · eligibility not stated';
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

function roleFamily(value) {
  const s = String(value || '').toLowerCase();
  if (/\b(customer support|customer service|technical support|support engineer|help desk|helpdesk|service desk)\b/.test(s)) return 'support';
  if (/\b(devops|site reliability|sre|platform engineer|cloud engineer|infrastructure engineer|systems engineer)\b/.test(s)) return 'devops';
  if (/\b(data scientist|machine learning scientist|research scientist|applied scientist)\b/.test(s)) return 'data-science';
  if (/\b(data engineer|analytics engineer|data platform engineer)\b/.test(s)) return 'data-engineering';
  if (/\b(data analyst|business intelligence|bi analyst|reporting analyst)\b/.test(s)) return 'data-analytics';
  if (/\b(machine learning|ml engineer|ai engineer|artificial intelligence|llm engineer|deep learning|computer vision)\b/.test(s)) return 'ai-ml';
  if (/\b(qa|quality assurance|test automation|automation tester|software tester|test engineer)\b/.test(s)) return 'qa-testing';
  if (/\b(product manager|product owner|product management)\b/.test(s)) return 'product';
  if (/\b(project manager|program manager|project coordinator|scrum master)\b/.test(s)) return 'project-program';
  if (/\b(ux designer|ui designer|product designer|graphic designer|visual designer)\b/.test(s)) return 'design';
  if (/\b(marketing|seo|content writer|copywriter|growth marketer|social media)\b/.test(s)) return 'marketing';
  if (/\b(sales|account executive|business development|sales development|account manager)\b/.test(s)) return 'sales';
  if (/\b(recruiter|talent acquisition|human resources|hr manager|people operations)\b/.test(s)) return 'human-resources';
  if (/\b(accountant|accounting|financial analyst|finance manager|bookkeeper|payroll)\b/.test(s)) return 'finance';
  if (/\b(backend|back end|frontend|front end|full stack|fullstack|software|developer|programmer|web engineer|web developer|application engineer|mobile developer|ios developer|android developer|firmware engineer|embedded engineer)\b/.test(s)) return 'software-engineering';
  return undefined;
}

function matchesQuery(job, query) {
  const title = text(job.position || job.title || job.jobTitle || job.job_title);
  if (!title) return false;
  const titleAndTags = [title, job.tags, job.category, job.categories, job.parentCategories].map(text).join(' ').toLowerCase();
  const targetFamily = roleFamily(query);
  const listingFamily = roleFamily(title);
  if (targetFamily && listingFamily && targetFamily !== listingFamily) return false;

  const stop = new Set(['the', 'and', 'for', 'with', 'senior', 'junior', 'staff', 'principal', 'lead', 'head', 'director', 'manager', 'associate', 'mid', 'level', 'remote', 'full', 'time', 'developer', 'engineer', 'software', 'programmer', 'web', 'specialist', 'analyst', 'scientist']);
  const core = [...new Set(tokens(query).filter((term) => !stop.has(term)))];
  if (core.length) {
    const matched = core.filter((term) => {
      const aliases = term === 'backend' ? ['backend', 'back end', 'back-end', 'server side', 'api']
        : term === 'frontend' ? ['frontend', 'front end', 'front-end']
        : term === 'react' ? ['react', 'reactjs', 'react.js']
        : term === 'node' ? ['node', 'node.js', 'nodejs']
        : [term];
      return aliases.some((alias) => titleAndTags.includes(alias));
    });
    return matched.length >= (core.length > 2 ? Math.ceil(core.length * 0.5) : 1);
  }
  if (targetFamily) return listingFamily === targetFamily;
  return tokens(query).some((term) => titleAndTags.includes(term));
}

function matchesLocation(job, requested) {
  const location = String(requested || '').trim();
  if (!location) return false;
  if (/^(remote|worldwide|global|anywhere|all locations|all countries)$/i.test(location)) return true;

  const structuredLocation = [
    job.location, job.location_country, job.region, job.locationRestrictions, job.location_restrictions,
    job.allowedCountries, job.allowed_countries, job.countries, job.eligibleLocations, job.eligible_locations
  ].map(text).join(' ').trim();
  if (isGlobalLocation(structuredLocation)) return true;

  const requestedNormalized = normalizeLocation(location);
  const actualNormalized = normalizeLocation(structuredLocation);
  if (actualNormalized && actualNormalized.includes(requestedNormalized)) return true;

  const requestedCountries = countriesFor(location);
  const listedCountries = countriesFor(structuredLocation);
  if (requestedCountries.length && listedCountries.length) {
    return requestedCountries.some((country) => listedCountries.includes(country));
  }
  const requestedRegions = regionsFor(location);
  const listedRegions = regionsFor(structuredLocation);
  if (requestedRegions.length && listedRegions.length) return requestedRegions.some((region) => listedRegions.includes(region));

  const description = text(job.description);
  if (isExplicitGlobalEligibility(description)) return true;

  if (structuredLocation) {
    const requestedTerms = tokens(location).filter((term) => term.length > 2);
    const actualTerms = new Set(tokens(structuredLocation));
    if (requestedTerms.some((term) => actualTerms.has(term))) return true;
    return false;
  }

  const restriction = description.match(/(?:based in|based out of|located in|must be (?:located|based|resident) in|residing in|residing within|candidates? (?:must|should) be (?:located|based) in|only available in|available only in|position is restricted to)\s+([^.<\n]{2,70})/i);
  if (restriction) {
    const requestedCountries = countriesFor(location);
    const allowedCountries = countriesFor(restriction[1]);
    if (requestedCountries.length && allowedCountries.length) {
      return requestedCountries.some((country) => allowedCountries.includes(country));
    }
    const allowedRegions = regionsFor(restriction[1]);
    if (requestedRegions.length && allowedRegions.length) return requestedRegions.some((region) => allowedRegions.includes(region));
    const allowed = normalizeLocation(restriction[1]);
    return allowed.includes(requestedNormalized) || requestedNormalized.includes(allowed);
  }
  return false;
}

function normalizeLocation(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
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
    location: displayLocation(job),
    country: text(job.location_country || job.country),
    locationRestrictions: text(job.locationRestrictions || job.location_restrictions),
    allowedCountries: text(job.allowedCountries || job.allowed_countries),
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

module.exports = { matchesLocation, matchesQuery, regionFor, regionsFor, countriesFor, roleFamily, displayLocation };
