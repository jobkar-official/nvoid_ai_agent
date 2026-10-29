import { Module } from '@nestjs/common';
import { BackendSyncService } from '../common/backend-sync.service';
import { AiAgentService } from '../common/ai-agent.service';
import { AgentApiKeyGuard } from '../common/api-key.guard';
import { McpModule } from '../mcp/mcp.module';
import { JobsController } from './jobs.controller';
import { JobDiscoveryService } from './job-discovery.service';

@Module({
  imports: [McpModule],
  controllers: [JobsController],
  providers: [JobDiscoveryService, BackendSyncService, AiAgentService, AgentApiKeyGuard],
  exports: [JobDiscoveryService],
})
export class JobsModule {}
