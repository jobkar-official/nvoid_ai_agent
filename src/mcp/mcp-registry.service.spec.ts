import { McpRegistryService } from './mcp-registry.service';
import type { McpServerConfig } from '../config/mcp-config.types';

function createService(config: McpServerConfig, tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): McpRegistryService {
  const service = new McpRegistryService({} as never, {} as never);
  const state = service as unknown as {
    servers: Map<string, { config: McpServerConfig; client: never; transport: never; tools: typeof tools; connected: boolean }>;
  };
  state.servers = new Map([[config.id, { config, client: undefined as never, transport: undefined as never, tools, connected: true }]]);
  return service;
}

describe('McpRegistryService job-search tool discovery', () => {
  it('discovers a real search tool when a connector uses a placeholder tool name', () => {
    const config: McpServerConfig = {
      id: 'naukri',
      name: 'Naukri MCP',
      enabled: true,
      transport: 'http',
      jobSearch: { tool: 'REPLACE_WITH_ACTUAL_SEARCH_TOOL_NAME', arguments: {} },
    };
    const service = createService(config, [
      { name: 'get_profile', description: 'Read a user profile' },
      {
        name: 'search_jobs',
        description: 'Search public job listings by keyword and location',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, location: { type: 'string' }, limit: { type: 'integer' } },
          required: ['query', 'location'],
        },
      },
    ]);

    const sources = service.getJobSearchServers();

    expect(sources).toHaveLength(1);
    expect(sources[0].server.id).toBe('naukri');
    expect(sources[0].tool).toBe('search_jobs');
    expect(sources[0].configured).toBe(false);
  });

  it('recognizes get_jobs as a listing tool on an MCP connector', () => {
    const config: McpServerConfig = {
      id: 'public-job-feed',
      name: 'Public Job Feed MCP',
      enabled: true,
      transport: 'http',
      jobSearch: { tool: 'REPLACE_WITH_ACTUAL_SEARCH_TOOL_NAME', arguments: {} },
    };
    const service = createService(config, [{
      name: 'get_jobs',
      description: 'Returns matching open jobs',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, location: { type: 'string' } }, required: ['query', 'location'] },
    }]);

    const sources = service.getJobSearchServers();

    expect(sources).toHaveLength(1);
    expect(sources[0].tool).toBe('get_jobs');
  });

  it('keeps an explicitly configured tool when that tool exists', () => {
    const config: McpServerConfig = {
      id: 'custom-jobs',
      name: 'Custom Jobs MCP',
      enabled: true,
      transport: 'http',
      jobSearch: { tool: 'find_open_roles', arguments: { query: { '$profile': 'jobTitle' } } },
    };
    const service = createService(config, [
      { name: 'find_open_roles', description: 'Find open job roles' },
    ]);

    const sources = service.getJobSearchServers();

    expect(sources).toHaveLength(1);
    expect(sources[0].tool).toBe('find_open_roles');
    expect(sources[0].configured).toBe(true);
  });
});
