# Job Agent Worker

A NestJS service for global job discovery and application orchestration. It connects to configurable MCP servers, discovers job-search tools, normalizes and deduplicates results, optionally uses an LLM for job fit scoring and cover-letter drafting, and processes application work through a distributed BullMQ queue. Browser workflows use Playwright.

This is a separate worker service. Keep your existing Next.js frontend and Spring Boot API. The worker exposes internal endpoints protected by `x-agent-api-key` and can post job/application events back to the backend.

## Live source coverage and integration boundaries

The default `config/mcp-servers.json` enables two public sources for live remote-job discovery:

- **Jobicy MCP**: sends the candidate's role and a supported geographic region, caches each role/region query for one hour, and preserves the canonical Jobicy listing URL.
- **Remote OK public feed**: fetches the public JSON feed, caches it for one hour, then locally filters records using the candidate's role and geographic preference while preserving the original Remote OK URL.

Both feeds are remote-job sources, not complete coverage of onsite jobs or every job portal. The canonical provider listing is always retained. Jobicy listings are deliberately excluded from the application queue because its public feed doesn't provide a verified employer application URL. Remote OK listings are queue-eligible only when the feed explicitly provides a separate direct `apply_url`; listing-only entries are not queued.

The local synthetic demo MCP source is disabled in the default runtime configuration and isolated in `config/mcp-servers.test.json` for CI. The Naukri and LinkedIn entries are disabled placeholders, not live integrations. They will not return portal jobs until a real, authorized MCP endpoint and its actual tool/argument schema are configured. MCP servers connected in ChatGPT or another desktop host are not automatically available to this NestJS worker.

## Features

- MCP client registry for multiple remote Streamable HTTP servers, legacy HTTP+SSE servers, and local stdio servers.
- Dynamic tool catalog and protected endpoint to call a selected MCP tool.
- Configurable job-search tool/argument mapping per MCP, with a conservative tool-name/schema discovery fallback.
- Normalized job records, deterministic matching, cross-source deduplication, and optional LLM-based reranking.
- One-call run workflow: search across MCPs, rank results, then enqueue the eligible top jobs.
- BullMQ queue backed by Redis, concurrency controls, retained task results, and deterministic IDs to reduce duplicate submissions per user.
- Playwright career-site workflow with form-field mapping, optional resume upload from a mounted private directory, screenshot artifacts, and CAPTCHA/login/assessment handoff.
- Optional authorized MCP application tools.
- Auto-submit off by default. Browser submission needs both an explicit task flag and an exact destination-domain allowlist.
- Backend job import and application status callbacks with configurable paths.
- Optional OpenAI-compatible chat-completions endpoint for fit reranking and cover letters. Without an LLM key, the worker uses deterministic scoring.
- API key protection, URL safety checks, no password collection, no CAPTCHA bypass, and no automatic retry after potentially uncertain submission.

## Requirements

- Node.js 22+
- Redis 7+
- A remote MCP endpoint or a local MCP server process for each configured job source
- Chromium for Playwright (`npx playwright install chromium`)

## Local development

```bash
cp .env.example .env
npm install
npx playwright install chromium
docker compose up -d redis
npm run start:dev
```

On a fresh Linux machine, install browser OS dependencies with:

```bash
npx playwright install --with-deps chromium
```

The API listens on port `3100` by default. Health is available without an API key at `GET /api/health`. All other endpoints require `x-agent-api-key` with the value of `AGENT_API_KEY`.

Build and test:

```bash
npm run build
npm test
```

## Run and test locally before connecting real job portals

The default `config/mcp-servers.json` enables a local MCP source named `demo`. It returns **synthetic test listings only** so you can verify the API, MCP connection, normalization, matching, queueing and manual-review behavior without portal credentials. Its application URLs use `example.com`; they are not real job listings. Naukri and LinkedIn entries remain disabled placeholders until you supply working, authorized MCP endpoints and their actual tool names.

### Docker quick start

```bash
cp .env.example .env
```

Set a private `AGENT_API_KEY` in `.env`; do not use the example value for a deployed service. Then run:

```bash
docker compose up --build -d
curl http://127.0.0.1:3100/api/health
npm ci
npm run smoke:test
```

The smoke test checks health and calls `POST /api/jobs/search` against the local demo source. It reads `AGENT_API_KEY` from `.env` and prints sample job titles with match scores. Set `NVOID_AGENT_URL` if the worker is running somewhere other than `http://127.0.0.1:3100`.

To exercise the queue and browser worker as well:

```bash
npm run smoke:test -- --workflow
```

This mode queues up to two synthetic jobs, with `autoSubmit: false`, then prints recent task states. The browser opens only the example.com demo URLs, which have no application form; a manual-review result is expected. It does not submit a real application. Use this test before configuring a live source.

### Run the API on your machine instead of Docker

Use Node.js 22+, a local Redis 7 instance, and Chromium for Playwright:

```bash
cp .env.example .env
npm ci
npx playwright install chromium
docker compose up -d redis
npm run start:dev
```

In another terminal, run `npm run smoke:test`. The `AGENT_API_KEY` value in `.env` must match the header used by the smoke test. The API health endpoint does not require the key; protected routes do.

### Run the automated checks

```bash
npm run lint:types
npm test -- --coverage
npm run build
```

## Configure MCP servers

Edit `config/mcp-servers.json`. Supported transports:

### Remote HTTP MCP

```json
{
  "id": "my-job-source",
  "name": "My Job Source",
  "enabled": true,
  "transport": "http",
  "url": "https://your-mcp-host.example/mcp",
  "headers": {
    "Authorization": "Bearer ${MY_MCP_TOKEN}"
  },
  "jobSearch": {
    "tool": "search_jobs",
    "arguments": {
      "query": { "$profile": "jobTitle" },
      "location": { "$profile": "location" },
      "limit": { "$context": "limit" }
    }
  }
}
```

Put the real `MY_MCP_TOKEN` in `.env`. Do not commit `.env` or tokens. Restart the service after editing the config file.

### Local stdio MCP

```json
{
  "id": "local-jobs",
  "name": "Local Job MCP",
  "enabled": true,
  "transport": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/mcp-server.js"],
  "env": {
    "UPSTREAM_API_TOKEN": "${UPSTREAM_API_TOKEN}"
  },
  "jobSearch": {
    "tool": "search_jobs",
    "arguments": {
      "query": { "$profile": "jobTitle" },
      "location": { "$profile": "location" }
    }
  }
}
```

Only configure stdio commands you trust: the worker will spawn the configured command as a child process. For isolation, it inherits only basic operating-system environment variables; secrets must be explicitly listed under that MCP server’s `env` section.

### Legacy SSE MCP

Set `"transport": "sse"`, `url` to the server's legacy SSE endpoint, and supply any required `headers`. Prefer Streamable HTTP for new integrations.

### Argument mapping

`jobSearch.arguments` maps the arguments expected by that connector's actual tool. Use these special objects:

- `{ "$profile": "jobTitle" }` - value from the candidate profile.
- `{ "$job": "sourceJobId" }` - value from the normalized job, mainly useful for application tools.
- `{ "$context": "limit" }` - requested search result limit.
- `"{{profile.skills}}"` - interpolated template value.

For an application-capable MCP, configure `jobApplication` with that server's actual submit tool and argument mapping. Example only:

```json
"jobApplication": {
  "tool": "submit_application",
  "arguments": {
    "jobId": { "$job": "sourceJobId" },
    "resumeUrl": { "$profile": "resumeUrl" },
    "email": { "$profile": "email" }
  }
}
```

Only configure `jobApplication` if the connector supports application submission and the user has authorized that action. The names above are illustrative; they are not assumed to exist on LinkedIn, Naukri, or any other platform.

The worker first uses explicit `jobSearch` mapping. If it is not present, it attempts to identify a likely job-search tool from the tool name/description and map common argument names using the published input schema. For production, explicitly configure each connector. Automatic discovery cannot safely guess every vendor's argument semantics.

## API endpoints

### Health

`GET /api/health`

### MCP status and catalog

- `GET /api/mcp/servers`
- `GET /api/mcp/tools`
- `GET /api/mcp/:serverId/tools`
- `POST /api/mcp/:serverId/tools/:toolName/call`

Example call body:

```json
{
  "arguments": {
    "query": "Java developer",
    "location": "India"
  }
}
```

### Search jobs only

`POST /api/jobs/search`

```json
{
  "profile": {
    "userId": "user-123",
    "jobTitle": "Java Backend Developer",
    "location": "India",
    "countries": ["India", "Germany"],
    "skills": ["Java", "Spring Boot", "PostgreSQL", "Redis"],
    "experienceYears": 4,
    "salaryMin": 1200000,
    "salaryCurrency": "INR",
    "employmentTypes": ["full-time"]
  },
  "limit": 100,
  "serverIds": ["naukri", "linkedin"],
  "syncToBackend": true
}
```

Remove `serverIds` to search all connected MCP servers that have a job-search tool. The `limit` is the final distinct result count, capped by `MAX_SEARCH_RESULTS`. A source tool can still return more results than requested; the normalizer and deduper reduce them before returning.

### Run the complete workflow: search, rank, queue

`POST /api/agent/run`

```json
{
  "userId": "user-123",
  "profile": {
    "jobTitle": "Java Backend Developer",
    "location": "India",
    "countries": ["India", "Germany"],
    "skills": ["Java", "Spring Boot", "PostgreSQL", "Redis"],
    "experienceYears": 4,
    "salaryMin": 1200000,
    "salaryCurrency": "INR",
    "employmentTypes": ["full-time"],
    "email": "candidate@example.com",
    "resumePath": "candidate-123.pdf"
  },
  "searchLimit": 100,
  "applyLimit": 50,
  "minMatchScore": 65,
  "serverIds": ["naukri", "linkedin"],
  "autoSubmit": false,
  "syncToBackend": true
}
```

This searches all chosen MCPs in parallel, normalizes and deduplicates results, optionally reranks jobs with the LLM, selects jobs at or above `minMatchScore`, and queues up to `applyLimit` eligible jobs. Set `autoSubmit: true` only when you deliberately want submission attempts. `AUTO_SUBMIT_ENABLED=true` is also required.

### Queue applications separately

`POST /api/applications/enqueue` takes `userId`, `profile`, a `jobs` array, and `autoSubmit`. Use this when the frontend/back end already owns a selected job batch.

### Track work

- `GET /api/applications/tasks?limit=50`
- `GET /api/applications/tasks/:taskId`

States include queue states such as `waiting`, `active`, `completed`, `failed`, `delayed`, and the result statuses `APPLIED`, `FAILED`, `NEEDS_USER_ACTION`, and `SKIPPED`. A task is only marked `APPLIED` when a connector result or the browser page provides a recognizable success signal. If the submit action may have happened but confirmation is unclear, the result is `NEEDS_USER_ACTION`; do not retry without checking the target site.

### Authentication header

```http
x-agent-api-key: replace-with-a-long-random-secret
```

Do not place `AGENT_API_KEY` in browser-side JavaScript. Call these worker APIs from your Spring Boot backend or another trusted server-side service.

## Automatic submission safety controls

Auto-submit is disabled unless **both** conditions are met:

1. `.env` contains `AUTO_SUBMIT_ENABLED=true` and the request has `"autoSubmit": true`.
2. Browser submissions navigate to an approved host listed in `ALLOWED_AUTO_APPLY_DOMAINS`, including after redirects.

Example:

```env
AUTO_SUBMIT_ENABLED=true
ALLOWED_AUTO_APPLY_DOMAINS=careers.company-a.com,jobs.company-b.com,boards.greenhouse.io
```

Only list domains where your integration and the user's authorization permit automation. A configured MCP `jobApplication` tool is treated as an explicitly configured API integration, but still requires global auto-submit and per-task opt-in. Platform terms and technical permissions still apply.

Browser requests to local/private/reserved addresses are blocked to reduce server-side request forgery exposure. The worker does not solve CAPTCHA, bypass access controls, rotate IPs to evade restrictions, invent candidate qualifications, or submit passwords. Login-required pages, assessments, unsupported forms, and uncertain submission outcomes stop for manual action. Browser sessions are temporary; in review mode, a screenshot and original application URL are recorded, not a live remote browser session the user can continue interacting with.

## Resume files

For browser upload, `profile.resumePath` must refer to a file inside `RESUME_STORAGE_DIR`. The recommended setup is a private shared volume that your backend worker can populate and the agent worker can read. Do not accept arbitrary filesystem paths from an untrusted client. In the Docker setup, mount approved files to `./private-resumes` on the host. For signed resume URLs, implement an authenticated download step and store the file inside this directory before enqueueing.

## Optional AI features

Set the following to enable AI reranking and cover-letter drafting using an OpenAI-compatible Chat Completions endpoint:

```env
LLM_API_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-available-model-id
LLM_TIMEOUT_MS=30000
```

The service sends only job/profile fields needed for matching and cover-letter creation, not the candidate's email or phone for scoring. Without `LLM_API_KEY` and `LLM_MODEL`, deterministic matching is used. AI scores are blended with deterministic scores; they do not override deterministic hard checks for known salary-range or employment-type conflicts before application execution.

## Connect to your existing backend

Configure:

```env
BACKEND_API_BASE_URL=https://your-api-host
BACKEND_API_TOKEN=your-internal-backend-token
BACKEND_JOB_IMPORT_PATH=/your-existing/internal/job-import-route
BACKEND_APPLICATION_EVENT_PATH=/your-existing/internal/application-event-route
BACKEND_REQUEST_TIMEOUT_MS=15000
```

The default paths are examples, not claims about your existing Spring Boot routes. Change them to the routes already implemented by your backend, and adapt `BackendSyncService` payloads to that API's schema. Without `BACKEND_API_BASE_URL`, search and queueing still work, but the worker will not push records to the backend.

## Run with Docker Compose

1. Copy `.env.example` to `.env` and set a long `AGENT_API_KEY`.
2. Configure at least one real MCP server and its actual tools.
3. Create `private-resumes/` and `artifacts/` directories.
4. Start it:

```bash
docker compose up --build -d
```

Docker Compose keeps the API bound to `127.0.0.1:3100`; place it behind your private network/reverse proxy and do not expose it publicly without appropriate access controls. Redis persistence uses a named Docker volume.

## Scaling

Run multiple replicas of this worker service against the same Redis instance and queue prefix. BullMQ distributes queued tasks among connected workers. A Redis-backed per-host lock prevents worker replicas from concurrently automating the same destination host. Set `APPLICATION_WORKER_CONCURRENCY` according to memory, browser overhead, the job sources' limits, and measured capacity. Increase slowly; do not run one browser per job without a concurrency budget. The worker uses a deterministic task ID per user/destination and does not automatically retry application tasks, to reduce accidental duplicate submissions after ambiguous failures.
