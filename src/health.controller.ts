import { Controller, Get } from '@nestjs/common';
import { McpRegistryService } from './mcp/mcp-registry.service';

@Controller('health')
export class HealthController {
  constructor(private readonly registry: McpRegistryService) {}

  @Get()
  health() {
    const servers = this.registry.getStatuses();
    return {
      status: 'ok',
      service: 'job-agent-worker',
      timestamp: new Date().toISOString(),
      mcp: {
        configured: servers.length,
        connected: servers.filter((server) => server.connected).length,
      },
    };
  }
}
