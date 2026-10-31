const baseUrl = (process.env.NVOID_AGENT_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const apiKey = process.env.AGENT_API_KEY;

if (!apiKey) {
  throw new Error('AGENT_API_KEY must be set for the live-source smoke test.');
}

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: {
      accept: 'application/json',
      'x-agent-api-key': apiKey,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(90000)
  });
  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { error: raw };
  }
  if (!response.ok) {
    throw new Error(path + ' returned HTTP ' + response.status + ': ' + JSON.stringify(data));
  }
  return data;
}

const profile = {
  userId: 'nvoid-live-source-smoke',
  jobTitle: 'Software Developer',
  location: 'Worldwide',
  countries: ['India', 'Germany', 'United Kingdom', 'Canada', 'Worldwide'],
  skills: ['TypeScript', 'Java', 'Python', 'Node.js'],
  keywords: ['backend', 'API', 'remote'],
  experienceYears: 3,
  employmentTypes: ['full-time'],
  remote: true
};

const health = await request('/api/health');
if (health.status !== 'ok') throw new Error('Agent health check failed.');
if ((health.mcp?.connected ?? 0) < 7) {
  throw new Error('Expected the seven default live job sources to be connected; health returned ' + JSON.stringify(health.mcp));
}

const search = await request('/api/jobs/search', {
  method: 'POST',
  body: JSON.stringify({ profile, limit: 30, syncToBackend: false })
});

const sources = Array.isArray(search.sources) ? search.sources : [];
const sourceIds = new Set(sources.map((source) => source.serverId));
for (const requiredSource of ['jobicy', 'remoteok', 'arbeitnow', 'workingnomads', 'himalayas', 'remotive', 'weworkremotely']) {
  if (!sourceIds.has(requiredSource)) {
    throw new Error('Live source ' + requiredSource + ' was not included in search results: ' + JSON.stringify(sources));
  }
}

const requiredLiveSources = new Set(['jobicy', 'remoteok', 'arbeitnow', 'workingnomads', 'himalayas', 'remotive', 'weworkremotely']);
const failedRequiredSources = sources.filter((source) => requiredLiveSources.has(source.serverId) && source.error);
const optionalSourceWarnings = sources.filter((source) => !requiredLiveSources.has(source.serverId) && source.error);
if (failedRequiredSources.length) {
  throw new Error('A required live provider request failed: ' + JSON.stringify(failedRequiredSources));
}
if (optionalSourceWarnings.length) {
  console.warn('Optional provider tool warnings (' + optionalSourceWarnings.length + '):');
  for (const source of optionalSourceWarnings) {
    console.warn('- ' + source.serverId + (source.tool ? '/' + source.tool : '') + ': ' + source.error);
  }
}

const jobs = Array.isArray(search.jobs) ? search.jobs : [];
if (jobs.length === 0) throw new Error('All live sources responded but the combined role-filtered search returned zero jobs.');

const liveSourceIds = [
  'jobicy', 'remoteok', 'arbeitnow', 'workingnomads', 'himalayas', 'remotive', 'weworkremotely',
  '104', 'amazon', 'apple', 'cake', 'freehire', 'flowxtra', 'google', 'indeed', 'jobindex',
  'linkedin', 'meta', 'mynavi', 'tsmc', 'jobspy', 'aidevboard', 'jobdatalake', 'apna',
  'apify-boards', 'naukri', 'glassdoor', 'ziprecruiter', 'bdjobs', 'bayt', 'hellowork',
];
const invalid = jobs.filter((job) => !liveSourceIds.includes(job.source) || !/^https?:\/\//i.test(job.jobUrl || ''));
if (invalid.length) throw new Error('Search returned a non-live source or a listing without an external URL: ' + JSON.stringify(invalid.slice(0, 2)));
const offRoleSeniority = jobs.filter((job) => /\b(director|head of|vice president|\bvp\b|chief|cto|cio|ceo|engineering manager|software manager|team lead|lead software engineer|principal engineer|distinguished engineer)\b/i.test(job.title || ''));
if (offRoleSeniority.length) {
  throw new Error('Role matching returned leadership-level jobs for the Software Developer query: ' + JSON.stringify(offRoleSeniority.map((job) => ({ title: job.title, source: job.source, url: job.jobUrl })).slice(0, 3)));
}

console.log('LIVE SOURCE CHECK PASSED');
console.log('Connected sources: ' + health.mcp.connected + '/' + health.mcp.configured);
for (const source of sources) {
  console.log(source.serverId + (source.tool ? '/' + source.tool : '') + ': ' + source.found + ' current listing(s)'
    + (source.connectionStatus === 'skipped' ? ' (skipped for this profile)' : ''));
}
console.log('Combined results: ' + jobs.length);
for (const job of jobs.slice(0, 10)) {
  console.log('- [' + job.source + '] ' + job.title + ' — ' + (job.company || 'Company not listed') + ' — ' + (job.postedAt || 'publication date not supplied') + ' — ' + job.jobUrl);
}
const cityProfile = {
  ...profile,
  jobTitle: 'Software Developer',
  location: 'Bengaluru, India',
  countries: ['India'],
  remote: false
};
const citySearch = await request('/api/jobs/search', {
  method: 'POST',
  body: JSON.stringify({ profile: cityProfile, limit: 30, syncToBackend: false })
});
const citySources = Array.isArray(citySearch.sources) ? citySearch.sources : [];
const cityErrors = citySources.filter((source) => requiredLiveSources.has(source.serverId) && source.error);
const cityOptionalWarnings = citySources.filter((source) => !requiredLiveSources.has(source.serverId) && source.error);
if (cityErrors.length) {
  throw new Error('City-specific search had required live source errors: ' + JSON.stringify(cityErrors));
}
if (cityOptionalWarnings.length) {
  console.warn('Optional city-search provider warnings (' + cityOptionalWarnings.length + '):');
  for (const source of cityOptionalWarnings) {
    console.warn('- ' + source.serverId + (source.tool ? '/' + source.tool : '') + ': ' + source.error);
  }
}
const cityJobs = Array.isArray(citySearch.jobs) ? citySearch.jobs : [];
const invalidCityJobs = cityJobs.filter((job) => !liveSourceIds.includes(job.source) || !/^https?:\/\//i.test(job.jobUrl || ''));
if (invalidCityJobs.length) {
  throw new Error('City-specific search returned a non-live source or a listing without a URL: ' + JSON.stringify(invalidCityJobs.slice(0, 2)));
}
console.log('City-specific query: Software Developer · Bengaluru, India');
for (const source of citySources) {
  console.log(source.serverId + ' city matches: ' + source.found);
}
console.log('Combined city-eligible results: ' + cityJobs.length);
for (const job of cityJobs.slice(0, 10)) {
  console.log('- [' + job.source + '] ' + job.title + ' — ' + (job.company || 'Company not listed') + ' — ' + (job.location || 'location not listed') + ' — ' + job.jobUrl);
}
console.log('No application was submitted and backend synchronization remained disabled.');
