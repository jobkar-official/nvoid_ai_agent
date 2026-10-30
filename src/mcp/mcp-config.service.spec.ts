import { McpConfigService } from './mcp-config.service';

describe('McpConfigService direct MCP activation', () => {
  it('auto-enables an authorized direct job-board endpoint and resolves its token', () => {
    const keys = ['NAUKRI_MCP_URL', 'NAUKRI_MCP_TOKEN'] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.NAUKRI_MCP_URL = 'https://mcp.example.test/naukri';
    process.env.NAUKRI_MCP_TOKEN = 'test-token';

    try {
      const service = new McpConfigService({ get: () => './config/mcp-servers.json' } as never);
      const naukri = service.load().find((server) => server.id === 'naukri');

      expect(naukri?.enabled).toBe(true);
      expect(naukri?.url).toBe('https://mcp.example.test/naukri');
      expect(naukri?.headers?.Authorization).toBe('Bearer test-token');
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});
