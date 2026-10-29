export const APPLICATION_QUEUE = 'application-tasks';
const configuredConcurrency = Number.parseInt(process.env.APPLICATION_WORKER_CONCURRENCY ?? '3', 10);
export const APPLICATION_WORKER_CONCURRENCY = Number.isFinite(configuredConcurrency) ? Math.max(1, configuredConcurrency) : 3;
