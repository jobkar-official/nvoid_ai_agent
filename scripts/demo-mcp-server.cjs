#!/usr/bin/env node
const readline = require('node:readline');

const jobs = [
  {
    id: 'demo-java-bengaluru',
    title: 'Java Backend Engineer',
    company: 'Nvoid Demo Systems',
    location: 'Bengaluru',
    country: 'India',
    description: 'Demo listing for Java, Spring Boot, REST APIs, PostgreSQL and Redis. Synthetic data for local testing only.',
    skills: ['Java', 'Spring Boot', 'REST APIs', 'PostgreSQL', 'Redis'],
    employmentType: 'Full-time',
    workMode: 'Hybrid',
    salaryMin: 1400000,
    salaryMax: 2400000,
    salaryCurrency: 'INR',
    url: 'https://example.com/nvoid-demo/java-backend-bengaluru'
  },
  {
    id: 'demo-software-remote',
    title: 'Software Developer — Remote',
    company: 'Nvoid Demo Labs',
    location: 'Remote (Worldwide)',
    country: 'Worldwide',
    description: 'Demo listing for software development, TypeScript, Node.js, APIs and distributed systems. Synthetic data for local testing only.',
    skills: ['TypeScript', 'Node.js', 'REST APIs', 'Distributed Systems'],
    employmentType: 'Full-time',
    workMode: 'Remote',
    salaryMin: 70000,
    salaryMax: 110000,
    salaryCurrency: 'USD',
    url: 'https://example.com/nvoid-demo/software-remote'
  },
  {
    id: 'demo-python-delhi',
    title: 'Python Developer',
    company: 'Nvoid Demo Analytics',
    location: 'New Delhi',
    country: 'India',
    description: 'Demo listing for Python, data processing, FastAPI, SQL and automated testing. Synthetic data for local testing only.',
    skills: ['Python', 'FastAPI', 'SQL', 'Testing'],
    employmentType: 'Full-time',
    workMode: 'On-site',
    salaryMin: 1000000,
    salaryMax: 1800000,
    salaryCurrency: 'INR',
    url: 'https://example.com/nvoid-demo/python-delhi'
  },
  {
    id: 'demo-java-berlin',
    title: 'Backend Software Engineer',
    company: 'Nvoid Demo Europe',
    location: 'Berlin',
    country: 'Germany',
    description: 'Demo listing for Java, Spring Boot, cloud services and microservices. Synthetic data for local testing only.',
    skills: ['Java', 'Spring Boot', 'Microservices', 'Cloud'],
    employmentType: 'Full-time',
    workMode: 'Hybrid',
    salaryMin: 65000,
    salaryMax: 85000,
    salaryCurrency: 'EUR',
    url: 'https://example.com/nvoid-demo/backend-berlin'
  },
  {
    id: 'demo-frontend-remote',
    title: 'Frontend Engineer',
    company: 'Nvoid Demo Studio',
    location: 'Remote (Worldwide)',
    country: 'Worldwide',
    description: 'Demo listing for React, TypeScript, accessibility and frontend performance. Synthetic data for local testing only.',
    skills: ['React', 'TypeScript', 'JavaScript', 'Accessibility'],
    employmentType: 'Full-time',
    workMode: 'Remote',
    salaryMin: 60000,
    salaryMax: 95000,
    salaryCurrency: 'USD',
    url: 'https://example.com/nvoid-demo/frontend-remote'
  },
  {
    id: 'demo-cloud-london',
    title: 'Cloud Platform Engineer',
    company: 'Nvoid Demo Infrastructure',
    location: 'London',
    country: 'United Kingdom',
    description: 'Demo listing for AWS, Docker, Kubernetes, Terraform and observability. Synthetic data for local testing only.',
    skills: ['AWS', 'Docker', 'Kubernetes', 'Terraform'],
    employmentType: 'Full-time',
    workMode: 'Hybrid',
    salaryMin: 65000,
    salaryMax: 90000,
    salaryCurrency: 'GBP',
    url: 'https://example.com/nvoid-demo/cloud-london'
  },
  {
    id: 'demo-qa-toronto',
    title: 'QA Automation Engineer',
    company: 'Nvoid Demo Quality',
    location: 'Toronto',
    country: 'Canada',
    description: 'Demo listing for Playwright, API testing, TypeScript and continuous integration. Synthetic data for local testing only.',
    skills: ['Playwright', 'TypeScript', 'API Testing', 'CI'],
    employmentType: 'Full-time',
    workMode: 'Hybrid',
    salaryMin: 85000,
    salaryMax: 115000,
    salaryCurrency: 'CAD',
    url: 'https://example.com/nvoid-demo/qa-toronto'
  },
  {
    id: 'demo-data-bengaluru',
    title: 'Data Engineer',
    company: 'Nvoid Demo Data',
    location: 'Bengaluru',
    country: 'India',
    description: 'Demo listing for Python, SQL, ETL pipelines and cloud data platforms. Synthetic data for local testing only.',
    skills: ['Python', 'SQL', 'ETL', 'Cloud'],
    employmentType: 'Full-time',
    workMode: 'Hybrid',
    salaryMin: 1600000,
    salaryMax: 2600000,
    salaryCurrency: 'INR',
    url: 'https://example.com/nvoid-demo/data-bengaluru'
  }
];

const serverInfo = { name: 'nvoid-demo-job-source', version: '1.0.0' };
const tools = [
  {
    name: 'search_jobs',
    description: 'Search synthetic Nvoid demo jobs for testing only. These are not real vacancies.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Target role or search keywords' },
        location: { type: 'string', description: 'City, country, Remote, or Worldwide' },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      required: ['query']
    }
  }
];

function searchJobs(args) {
  const query = String(args.query ?? '').trim().toLowerCase();
  const location = String(args.location ?? 'Worldwide').trim().toLowerCase();
  const queryTokens = query.split(/[^a-z0-9+#.]+/).filter((term) => term.length > 2 && !['software', 'developer', 'engineer', 'jobs', 'job', 'full', 'time'].includes(term));
  const locationTokens = location.split(/[^a-z0-9]+/).filter((term) => term.length > 1);
  const anywhere = !locationTokens.length || /^(worldwide|global|anywhere|all locations|all countries)$/.test(location);

  const matches = jobs.filter((job) => {
    const haystack = [job.title, job.description, ...job.skills].join(' ').toLowerCase();
    const queryMatches = queryTokens.length === 0 || queryTokens.some((term) => haystack.includes(term));
    const locationText = `${job.location} ${job.country} ${job.workMode}`.toLowerCase();
    const locationMatches = anywhere
      || (location.includes('remote') && (job.workMode.toLowerCase().includes('remote') || job.location.toLowerCase().includes('remote')))
      || locationTokens.every((term) => locationText.includes(term));
    return queryMatches && locationMatches;
  });

  const limit = Number.isFinite(Number(args.limit)) ? Math.min(100, Math.max(1, Number(args.limit))) : 20;
  return matches.slice(0, limit).map((job) => ({ ...job, demo: true }));
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  const id = message.id;
  const hasId = id !== undefined && id !== null;

  if (message.method === 'notifications/initialized' || message.method.startsWith('notifications/')) return;
  if (!hasId) return;

  if (message.method === 'initialize') {
    const requestedVersion = message.params && typeof message.params.protocolVersion === 'string'
      ? message.params.protocolVersion
      : '2025-11-25';
    respond(id, {
      protocolVersion: requestedVersion,
      capabilities: { tools: {} },
      serverInfo
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
    const name = message.params && message.params.name;
    if (name !== 'search_jobs') {
      respondError(id, -32602, `Unknown demo tool: ${String(name)}`);
      return;
    }
    const args = message.params && message.params.arguments && typeof message.params.arguments === 'object'
      ? message.params.arguments
      : {};
    const result = { jobs: searchJobs(args), demo: true, note: 'Synthetic test data only; no live job portal was queried.' };
    respond(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false
    });
    return;
  }

  respondError(id, -32601, `Unsupported method: ${message.method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  try {
    void handle(JSON.parse(line)).catch((error) => {
      process.stderr.write(`Demo MCP request failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  } catch {
    process.stderr.write('Ignored invalid JSON on demo MCP input.\n');
  }
});
