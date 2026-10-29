import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { McpRegistryService } from './mcp/mcp-registry.service';

describe('HealthController', () => {
  it('reports a healthy agent and MCP connection totals', async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{
        provide: McpRegistryService,
        useValue: { getStatuses: () => [
          { id: 'one', name: 'One', enabled: true, transport: 'http', connected: true, toolCount: 2, tools: [] },
          { id: 'two', name: 'Two', enabled: true, transport: 'http', connected: false, toolCount: 0, tools: [] },
        ] },
      }],
    }).compile();

    const controller = module.get(HealthController);
    const result = controller.health();
    expect(result.status).toBe('ok');
    expect(result.mcp.configured).toBe(2);
    expect(result.mcp.connected).toBe(1);
    await module.close();
  });
});
