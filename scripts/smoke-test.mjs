import 'dotenv/config';

const baseUrl = (process.env.NVOID_AGENT_URL ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const apiKey = process.env.AGENT_API_KEY;
const serverIds = process.env.NVOID_SMOKE_SOURCE_ID ? [process.env.NVOID_SMOKE_SOURCE_ID] : undefined;

if (!apiKey) {
  console.error('AGENT_API_KEY is missing. Copy .env.example to .env and set AGENT_API_KEY first.');
  process.exit(1);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      'x-agent-api-key': apiKey,
      ...options.headers
    }
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const profile = {
  userId: 'nvoid-smoke-test',
  jobTitle: 'Software Developer',
  location: 'Worldwide',
  countries: ['India', 'Germany', 'United Kingdom', 'Canada', 'Worldwide'],
  skills: ['Java', 'Spring Boot', 'TypeScript', 'Python', 'Playwright'],
  keywords: ['backend', 'API', 'remote'],
  experienceYears: 3,
  employmentTypes: ['full-time'],
  remote: false
};

try {
  const health = await request('/api/health');
  if (health.status !== 'ok') throw new Error('Health endpoint did not report status=ok.');
  console.log(`Health: ${health.status}; connected MCP sources: ${health.mcp?.connected ?? 0}`);

  const search = await request('/api/jobs/search', {
    method: 'POST',
    body: JSON.stringify({
      profile,
      limit: 20,
      ...(serverIds ? { serverIds } : {}),
      syncToBackend: false
    })
  });

  if (!Array.isArray(search.jobs) || search.jobs.length === 0) {
    const sourceSummary = Array.isArray(search.sources) ? search.sources.map((source) => source.serverId + ': ' + (source.error || (source.found + ' jobs'))).join('; ') : 'no source details returned';
    throw new Error('Job search returned no jobs. Check enabled source configuration and provider connectivity. ' + sourceSummary);
  }

  console.log(`Search smoke test passed: ${search.returnedCount} jobs from ${search.sourceCount} connected source(s).`);
  for (const source of search.sources ?? []) {
    console.log(`Source ${source.serverId}: ${source.found} job(s)${source.error ? ' · ERROR: ' + source.error : ''}`);
  }
  for (const job of search.jobs.slice(0, 5)) {
    console.log(`- [${job.matchScore}%] ${job.title} — ${job.company ?? 'Company not listed'} (${job.location ?? 'Location not listed'})`);
  }

  if (process.argv.includes('--workflow')) {
    const workflow = await request('/api/agent/run', {
      method: 'POST',
      body: JSON.stringify({
        userId: profile.userId,
        profile,
        searchLimit: 10,
        applyLimit: 2,
        minMatchScore: 0,
        ...(serverIds ? { serverIds } : {}),
        autoSubmit: false,
        syncToBackend: false
      })
    });

    console.log('Workflow test accepted. Auto-submit was explicitly disabled.');
    console.log(JSON.stringify({
      matchingJobs: workflow.search?.returnedCount,
      applicationQueue: workflow.applicationQueue,
      autoSubmitRequested: workflow.autoSubmitRequested
    }, null, 2));

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const tasks = await request('/api/applications/tasks?limit=10');
    console.log('Recent application-task state:');
    console.log(JSON.stringify(tasks, null, 2));
    console.log('Review-only workflow finished. Queued work is not proof that any application was submitted.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
