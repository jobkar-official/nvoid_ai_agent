import { Module } from '@nestjs/common';
import { AgentApiKeyGuard } from '../common/api-key.guard';
import { McpConfigService } from './mcp-config.service';
import { McpController } from './mcp.controller';
import { McpRegistryService } from './mcp-registry.service';

@Module({
  controllers: [McpController],
  providers: [McpConfigService, McpRegistryService, AgentApiKeyGuard],
  exports: [McpConfigService, McpRegistryService],
})
export class McpModule {}
