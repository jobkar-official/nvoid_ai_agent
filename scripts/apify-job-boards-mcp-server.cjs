#!/usr/bin/env node
const readline = require('node:readline');

const MODE = process.argv[2];
const API_BASE = 'https://api.apify.com/v2';
const MAX_WAIT_MS = 180000;
const POLL_INTERVAL_MS = 2500;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MODES = {
  boards: {
    label: 'Naukri, LinkedIn, Indeed and Glassdoor via Apify',
    actorId: 'openclawai/job-board-scraper',
  },
  apna: {
    label: 'Apna jobs via Apify',
    actorId: 'automation-lab/apna-india-job-listings-scraper',
  },
};

if (!MODES[MODE] && require.main === module) {
  process.stderr.write('Use boards or apna as the source mode.\n');
  process.exit(2);
}

const config = MODES[MODE];
const cache = new Map();
const inFlight = new Map();
const tools = [{
  name: 'search_jobs',
  description: 'Search public job listings by target role and location using ' + (config?.label || 'an Apify job source') + '. Results keep the original board and canonical listing URL.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Target job title or keywords' },
      location: { type: 'string', description: 'Required city, region, or country' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      remoteOnly: { type: 'boolean' },
      skills: { type: 'array', items: { type: 'string' } },
      keywords: { type: 'array', items: { type: 'string' } }
    },
    required: ['query', 'location']
  }
}];

function text(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map(text).filter(Boolean).join(' ');
  return '';
}

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9+#.]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function tokens(value) {
  return normalize(value).split(' ').filter((part) => part.length > 1);
}

const ROLE_STOP = new Set(['the', 'and', 'for', 'with', 'senior', 'junior', 'staff', 'principal', 'lead', 'head', 'director', 'manager', 'associate', 'mid', 'level', 'remote', 'full', 'time', 'developer', 'engineer', 'software', 'programmer', 'web', 'specialist', 'analyst', 'scientist', 'consultant', 'professional', 'executive']);

function roleFamily(value) {
  const s = normalize(value);
  if (/\b(customer support|customer service|technical support|support engineer|help desk|helpdesk|service desk)\b/.test(s)) return 'support';
  if (/\b(devops|site reliability|sre|platform engineer|cloud engineer|infrastructure engineer|systems engineer|cloud operations)\b/.test(s)) return 'devops';
  if (/\b(data scientist|machine learning scientist|research scientist|applied scientist)\b/.test(s)) return 'data-science';
  if (/\b(data engineer|analytics engineer|data platform engineer)\b/.test(s)) return 'data-engineering';
  if (/\b(data analyst|business intelligence|bi analyst|reporting analyst)\b/.test(s)) return 'data-analytics';
  if (/\b(machine learning|ml engineer|ai engineer|artificial intelligence|llm engineer|deep learning|computer vision|nlp engineer)\b/.test(s)) return 'ai-ml';
  if (/\b(qa|quality assurance|test automation|automation tester|software tester|test engineer)\b/.test(s)) return 'qa-testing';
  if (/\b(product manager|product owner|product management)\b/.test(s)) return 'product';
  if (/\b(project manager|program manager|project coordinator|scrum master)\b/.test(s)) return 'project-program';
  if (/\b(ux designer|ui designer|product designer|graphic designer|visual designer|design researcher|ux researcher)\b/.test(s)) return 'design';
  if (/\b(marketing|seo|content writer|copywriter|growth marketer|social media|communications)\b/.test(s)) return 'marketing';
  if (/\b(sales|account executive|business development|sales development|account manager)\b/.test(s)) return 'sales';
  if (/\b(recruiter|talent acquisition|human resources|hr manager|people operations|hr business partner)\b/.test(s)) return 'human-resources';
  if (/\b(accountant|accounting|financial analyst|finance manager|bookkeeper|payroll)\b/.test(s)) return 'finance';
  if (/\b(backend|back end|frontend|front end|full stack|fullstack|software|developer|programmer|web engineer|web developer|application engineer|mobile developer|ios developer|android developer|firmware engineer|embedded engineer)\b/.test(s)) return 'software-engineering';
  return undefined;
}

function matchesRole(job, query) {
  const title = text(job.title || job.position || job.jobTitle || job.job_title);
  if (!title) return false;
  const evidence = normalize(title + ' ' + text(job.tags) + ' ' + text(job.skills) + ' ' + text(job.job_function) + ' ' + text(job.category));
  const targetFamily = roleFamily(query);
  const listingFamily = roleFamily(title);
  if (targetFamily && listingFamily && targetFamily !== listingFamily) return false;
  const terms = [...new Set(tokens(query).filter((term) => !ROLE_STOP.has(term)))];
  if (terms.length) {
    const matched = terms.filter((term) => {
      const aliases = term === 'backend' ? ['backend', 'back end', 'back-end', 'server side', 'api']
        : term === 'frontend' ? ['frontend', 'front end', 'front-end']
        : term === 'react' ? ['react', 'reactjs', 'react.js']
        : term === 'node' ? ['node', 'node.js', 'nodejs']
        : term === 'typescript' ? ['typescript', 'ts']
        : [term];
      return aliases.some((alias) => evidence.includes(normalize(alias)));
    });
    return matched.length >= (terms.length > 2 ? Math.ceil(terms.length * 0.5) : 1);
  }
  return Boolean(targetFamily && listingFamily === targetFamily);
}

function regionsFor(value) {
  const s = normalize(value);
  const checks = [
    ['latin-america', /\b(latin america|latam|south america|central america|brazil|argentina|mexico|colombia|chile|peru)\b/],
    ['apac', /\b(india|bengaluru|bangalore|delhi|mumbai|hyderabad|chennai|pune|kolkata|asia|apac|singapore|australia|japan|new zealand|philippines|pakistan|nepal|sri lanka|indonesia|thailand|vietnam|hong kong|malaysia)\b/],
    ['europe', /\b(europe|united kingdom|uk|london|germany|berlin|france|paris|netherlands|amsterdam|ireland|dublin|spain|italy|poland|sweden|norway|finland|portugal|switzerland|austria|belgium|denmark)\b/],
    ['north-america', /\b(usa|united states|america|new york|san francisco|california|texas|seattle|austin|chicago|boston|los angeles|canada|toronto|vancouver|north america)\b/],
    ['middle-east', /\b(middle east|uae|united arab emirates|dubai|saudi arabia|qatar|kuwait|bahrain|oman)\b/],
    ['africa', /\b(africa|south africa|nigeria|kenya|egypt|ghana)\b/],
  ];
  return checks.filter(([, pattern]) => pattern.test(s)).map(([region]) => region);
}

function countriesFor(value) {
  const s = normalize(value);
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

function isGlobal(value) {
  return /\b(worldwide|anywhere|global|all countries|work from anywhere|remote worldwide|world wide)\b/i.test(text(value));
}

function matchesLocation(job, requested, remoteOnly) {
  const target = String(requested || '').trim();
  if (!target) return false;
  if (/^(remote|worldwide|global|anywhere|all locations|all countries)$/i.test(target)) return true;
  const structured = [
    job.location, job.country, job.city, job.location_country, job.locationRestrictions,
    job.location_restrictions, job.allowedCountries, job.allowed_countries,
  ].map(text).filter(Boolean).join(' ');
  if (isGlobal(structured)) return true;

  const targetNormalized = normalize(target);
  const structuredNormalized = normalize(structured);
  if (structuredNormalized.includes(targetNormalized)) return true;
  const targetCountries = countriesFor(target);
  const listingCountries = countriesFor(structured);
  if (targetCountries.length && listingCountries.length) {
    return targetCountries.some((country) => listingCountries.includes(country));
  }
  const targetRegions = regionsFor(target);
  const listingRegions = regionsFor(structured);
  if (targetRegions.length && listingRegions.length) return targetRegions.some((region) => listingRegions.includes(region));

  const description = text(job.description);
  if (isExplicitGlobalEligibility(description)) return true;

  if (structuredNormalized) {
    const targetTerms = tokens(target).filter((term) => term.length > 2);
    const listingTerms = new Set(tokens(structured));
    if (targetTerms.some((term) => listingTerms.has(term))) return true;
    return false;
  }

  const restriction = description.match(/(?:based in|based out of|located in|must be (?:located|based|resident) in|residing in|residing within|candidates? (?:must|should) be (?:located|based) in|only available in|available only in|position is restricted to)\s+([^.<\n]{2,70})/i);
  if (restriction) {
    const targetCountries = countriesFor(target);
    const allowedCountries = countriesFor(restriction[1]);
    if (targetCountries.length && allowedCountries.length) {
      return targetCountries.some((country) => allowedCountries.includes(country));
    }
    const targetRegion = targetRegions[0];
    const allowedRegions = regionsFor(restriction[1]);
    if (targetRegion && allowedRegions.length) return allowedRegions.includes(targetRegion);
    const allowed = normalize(restriction[1]);
    return allowed.includes(targetNormalized) || targetNormalized.includes(allowed);
  }
  return false;
}

function countryFor(location) {
  const s = normalize(location);
  if (/\b(india|bengaluru|bangalore|delhi|mumbai|hyderabad|chennai|pune|kolkata)\b/.test(s)) return 'india';
  if (/\b(united kingdom|uk|london)\b/.test(s)) return 'uk';
  if (/\b(canada|toronto|vancouver|montreal)\b/.test(s)) return 'canada';
  if (/\b(australia|sydney|melbourne)\b/.test(s)) return 'australia';
  if (/\b(germany|berlin)\b/.test(s)) return 'germany';
  if (/\b(france|paris)\b/.test(s)) return 'france';
  return 'india';
}

function selectedSites() {
  if (MODE === 'apna') return ['apna'];
  const raw = process.env.APIFY_JOB_BOARDS_SITES || 'naukri,linkedin,indeed,glassdoor';
  const allowed = new Set(['naukri', 'linkedin', 'indeed', 'glassdoor', 'zip_recruiter', 'bayt']);
  const picked = raw.split(',').map((v) => v.trim().toLowerCase()).filter((site) => allowed.has(site));
  return [...new Set(picked.length ? picked : ['naukri', 'linkedin', 'indeed', 'glassdoor'])];
}

function normalizeSite(value) {
  const s = normalize(value);
  if (s.includes('naukri')) return 'naukri';
  if (s.includes('linkedin')) return 'linkedin';
  if (s.includes('indeed')) return 'indeed';
  if (s.includes('glassdoor')) return 'glassdoor';
  if (s.includes('apna')) return 'apna';
  if (s.includes('zip recruiter') || s === 'ziprecruiter') return 'ziprecruiter';
  if (s.includes('bayt')) return 'bayt';
  return s.replace(/\s+/g, '');
}

function credential() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token || token.startsWith(String.fromCharCode(36) + '{') || token === 'replace-with-your-apify-token') {
    throw new Error('This source needs APIFY_API_TOKEN in the agent .env. Add your Apify token locally, restart the worker, then enable this source in config/mcp-servers.json.');
  }
  return token;
}

async function apiRequest(path, options = {}) {
  const token = credential();
  const response = await fetch(API_BASE + path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token), {
    ...options,
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let detail = '';
    try { detail = text(JSON.parse(body).error?.message || JSON.parse(body).message); } catch {}
    throw new Error('Apify source request failed with HTTP ' + response.status + (detail ? ': ' + detail : ''));
  }
  return response.json();
}

function boardInput(args) {
  const sites = selectedSites();
  const input = {
    searchTerm: String(args.query).trim(),
    location: String(args.location).trim(),
    sites,
    countryIndeed: countryFor(args.location),
    maxResults: Math.min(
      Math.max(1, Number(process.env.APIFY_JOB_BOARDS_MAX_RESULTS) || 15),
      Math.max(1, Number(args.limit) || 15)
    ),
    isRemote: args.remoteOnly === true,
    descriptionFormat: 'markdown',
    enforceAnnualSalary: true,
    linkedinFetchDescription: true,
  };
  const hoursOld = Number(process.env.APIFY_JOB_MAX_AGE_HOURS);
  if (Number.isFinite(hoursOld) && hoursOld > 0) input.hoursOld = Math.min(720, Math.floor(hoursOld));
  return input;
}

function apnaInput(args) {
  const limit = Math.min(
    Math.max(1, Number(process.env.APIFY_APNA_MAX_ITEMS) || 25),
    Math.max(1, Number(args.limit) || 25)
  );
  return {
    keyword: String(args.query).trim(),
    location: String(args.location).trim(),
    maxItems: limit,
    maxPages: Math.max(1, Math.min(5, Math.ceil(limit / 25))),
    includeDescription: true,
    proxyConfiguration: { useApifyProxy: true },
  };
}

async function wait(delay) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}

async function runActor(actorId, input) {
  const actorPath = actorId.replace('/', '~');
  const started = await apiRequest('/acts/' + actorPath + '/runs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const runId = text(started.data?.id || started.id);
  if (!runId) throw new Error('Apify accepted the source run but returned no run ID.');
  const startedAt = Date.now();
  let run = started.data || started;
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const status = text(run.status).toUpperCase();
    if (status === 'SUCCEEDED') break;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      throw new Error('Apify actor run ended with status ' + status + (run.statusMessage ? ': ' + text(run.statusMessage) : ''));
    }
    await wait(POLL_INTERVAL_MS);
    const polled = await apiRequest('/actor-runs/' + encodeURIComponent(runId));
    run = polled.data || polled;
  }

  if (text(run.status).toUpperCase() !== 'SUCCEEDED') {
    throw new Error('Apify actor run exceeded the Nvoid source wait limit. Reduce max results or query one site at a time.');
  }
  const datasetId = text(run.defaultDatasetId || started.data?.defaultDatasetId || started.defaultDatasetId);
  if (!datasetId) throw new Error('Apify actor succeeded but returned no default dataset.');
  const limit = MODE === 'apna' ? input.maxItems : Math.min(200, Math.max(10, Number(input.maxResults) * selectedSites().length));
  const items = await apiRequest('/datasets/' + encodeURIComponent(datasetId) + '/items?clean=true&format=json&limit=' + limit);
  if (!Array.isArray(items)) throw new Error('Apify dataset response was not a JSON array.');
  return items;
}

function mapItem(item) {
  const site = MODE === 'apna' ? 'apna' : normalizeSite(item.site || item.source || item.source_site);
  return {
    id: text(item.id || item.jobId || item.job_id || item.slug || item.url || item.job_url),
    source: site,
    title: text(item.title || item.jobTitle || item.job_title || item.position),
    company: text(item.company || item.employer || item.companyName || item.company_name),
    location: text(item.location || item.city || item.job_location || item.locationRestrictions || item.location_restrictions),
    country: text(item.country || item.country_name || item.countryIndeed),
    description: text(item.description || item.snippet || item.excerpt),
    tags: Array.isArray(item.skills) ? item.skills.join(', ') : text(item.skills || item.tags || item.job_function || item.category),
    employmentType: text(item.job_type || item.employmentType || item.employment_type),
    workMode: item.is_remote === true || item.remote === true ? 'Remote' : text(item.workMode || item.work_mode || item.work_from_home_type),
    salaryMin: Number.isFinite(Number(item.salary_min)) && item.salary_min !== null ? Number(item.salary_min) : undefined,
    salaryMax: Number.isFinite(Number(item.salary_max)) && item.salary_max !== null ? Number(item.salary_max) : undefined,
    salaryCurrency: text(item.salary_currency || item.salaryCurrency) || undefined,
    postedAt: text(item.date_posted || item.datePosted || item.postedAt || item.posted_at || item.scraped_at),
    jobUrl: text(item.job_url || item.jobUrl || item.canonicalUrl || item.url || item.link),
    directUrl: text(item.job_url_direct || item.directApplyUrl || item.applicationUrl || item.application_url),
    raw: item,
  };
}

async function searchJobs(args) {
  const query = String(args.query || '').trim();
  const location = String(args.location || '').trim();
  if (!query || !location) throw new Error('Enter both a job title and preferred city, region, or country.');
  const sourceKey = MODE + '|' + normalize(query) + '|' + normalize(location) + '|' + String(args.remoteOnly === true) + '|' + String(args.limit || 20);
  const cached = cache.get(sourceKey);
  if (cached && cached.expiresAt > Date.now()) return cached.jobs;
  if (inFlight.has(sourceKey)) return inFlight.get(sourceKey);

  const pending = (async () => {
    const actorId = config.actorId;
    const input = MODE === 'apna' ? apnaInput(args) : boardInput(args);
    const items = await runActor(actorId, input);
    const jobs = items.map(mapItem).filter((job) => {
      const validSource = MODE === 'apna' ? job.source === 'apna' : ['naukri', 'linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'bayt'].includes(job.source);
      return validSource && job.title && job.jobUrl && /^https?:\/\//i.test(job.jobUrl);
    }).filter((job) => matchesRole(job, query) && matchesLocation(job, location, MODE === 'apna' || args.remoteOnly === true));
    cache.set(sourceKey, { jobs, expiresAt: Date.now() + CACHE_TTL_MS });
    return jobs;
  })();

  inFlight.set(sourceKey, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(sourceKey);
  }
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
  if (id === undefined || id === null || message.method.startsWith('notifications/')) return;
  if (message.method === 'initialize') {
    respond(id, { protocolVersion: message.params?.protocolVersion || '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'nvoid-apify-' + (MODE || 'source'), version: '1.0.0' } });
    return;
  }
  if (message.method === 'ping') { respond(id, {}); return; }
  if (message.method === 'tools/list') { respond(id, { tools }); return; }
  if (message.method === 'tools/call') {
    if (message.params?.name !== 'search_jobs') {
      respondError(id, -32602, 'Unknown tool: ' + String(message.params?.name));
      return;
    }
    try {
      const args = message.params?.arguments && typeof message.params.arguments === 'object' ? message.params.arguments : {};
      const jobs = await searchJobs(args);
      respond(id, {
        content: [{ type: 'text', text: JSON.stringify({ jobs, source: config.label, returnedCount: jobs.length }) }],
        structuredContent: { jobs, source: config.label, returnedCount: jobs.length },
        isError: false
      });
    } catch (error) {
      respondError(id, -32000, error instanceof Error ? error.message : String(error));
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
      void handle(JSON.parse(line)).catch((error) => process.stderr.write('Apify job source failed: ' + (error instanceof Error ? error.message : String(error)) + '\n'));
    } catch {
      process.stderr.write('Ignored invalid JSON on Apify MCP input.\n');
    }
  });
}

if (require.main === module) start();
module.exports = { matchesRole, matchesLocation, roleFamily, regionsFor, countriesFor, mapItem, countryFor };
