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
  it('uses only the configured public search tool on MCPs with additional account and recommendation tools', () => {
    const config: McpServerConfig = {
      id: 'himalayas-mcp',
      name: 'Himalayas MCP',
      enabled: true,
      transport: 'http',
      jobSearch: { tool: 'search_jobs', arguments: { keyword: 'Backend Engineer' } },
    };
    const service = createService(config, [
      { name: 'search_jobs', description: 'Search public remote job listings' },
      { name: 'get_jobs', description: 'Browse recent job listings' },
      { name: 'get_related_jobs', description: 'Find related job listings' },
      { name: 'get_job_details', description: 'Read one full job listing' },
      { name: 'personalized_job_hunt', description: 'Find jobs using a signed-in candidate profile and account preferences' },
    ]);

    const sources = service.getJobSearchServers();

    expect(sources).toHaveLength(1);
    expect(sources[0].tool).toBe('search_jobs');
    expect(sources[0].configured).toBe(true);
  });

  it('keeps each provider-specific search tool from the Openings MCP board catalog', () => {
    const config: McpServerConfig = {
      id: 'openings-mcp',
      name: 'Openings MCP',
      enabled: true,
      transport: 'stdio',
      jobSearch: { tool: 'linkedin_search_jobs', arguments: {} },
    };
    const service = createService(config, [
      { name: 'linkedin_search_jobs', description: 'Search LinkedIn job listings' },
      { name: 'indeed_search_jobs', description: 'Search Indeed job listings' },
      { name: 'linkedin_get_job', description: 'Read one LinkedIn job detail' },
      { name: 'search_companies', description: 'Search companies' },
    ]);

    const sources = service.getJobSearchServers();

    expect(sources.map((source) => source.tool)).toEqual(['linkedin_search_jobs', 'indeed_search_jobs']);
  });

});
