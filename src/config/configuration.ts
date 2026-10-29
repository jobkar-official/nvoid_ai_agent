export default () => ({
  port: Number.parseInt(process.env.PORT ?? '3100', 10),
  agentApiKey: process.env.AGENT_API_KEY ?? '',
  mcpServersConfig: process.env.MCP_SERVERS_CONFIG ?? './config/mcp-servers.json',
  mcpConnectTimeoutMs: Number.parseInt(process.env.MCP_CONNECT_TIMEOUT_MS ?? '15000', 10),
  mcpCallTimeoutMs: Number.parseInt(process.env.MCP_CALL_TIMEOUT_MS ?? '60000', 10),
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number.parseInt(process.env.REDIS_PORT ?? '6379', 10),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true',
  },
  queuePrefix: process.env.APPLICATION_QUEUE_PREFIX ?? 'job-agent',
  applicationConcurrency: Math.max(1, Number.parseInt(process.env.APPLICATION_WORKER_CONCURRENCY ?? '3', 10)),
  domainLockTtlMs: Math.max(30000, Number.parseInt(process.env.DOMAIN_LOCK_TTL_MS ?? '180000', 10)),
  domainLockMaxWaitMs: Math.max(1000, Number.parseInt(process.env.DOMAIN_LOCK_MAX_WAIT_MS ?? '90000', 10)),
  autoSubmitEnabled: process.env.AUTO_SUBMIT_ENABLED === 'true',
  allowedAutoApplyDomains: (process.env.ALLOWED_AUTO_APPLY_DOMAINS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
  browserHeadless: process.env.BROWSER_HEADLESS !== 'false',
  browserActionTimeoutMs: Number.parseInt(process.env.BROWSER_ACTION_TIMEOUT_MS ?? '15000', 10),
  browserNavigationTimeoutMs: Number.parseInt(process.env.BROWSER_NAVIGATION_TIMEOUT_MS ?? '30000', 10),
  resumeStorageDir: process.env.RESUME_STORAGE_DIR ?? './private-resumes',
  screenshotDir: process.env.SCREENSHOT_DIR ?? './artifacts',
  maxSearchResults: Math.min(500, Math.max(1, Number.parseInt(process.env.MAX_SEARCH_RESULTS ?? '200', 10))),
  llm: {
    baseUrl: process.env.LLM_API_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? '',
    timeoutMs: Number.parseInt(process.env.LLM_TIMEOUT_MS ?? '30000', 10),
  },
  backend: {
    baseUrl: process.env.BACKEND_API_BASE_URL ?? '',
    token: process.env.BACKEND_API_TOKEN ?? '',
    jobImportPath: process.env.BACKEND_JOB_IMPORT_PATH ?? '/internal/agent/jobs/import',
    applicationEventPath: process.env.BACKEND_APPLICATION_EVENT_PATH ?? '/internal/agent/applications/events',
    requestTimeoutMs: Number.parseInt(process.env.BACKEND_REQUEST_TIMEOUT_MS ?? '15000', 10),
  },
});
