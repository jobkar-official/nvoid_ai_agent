import { Module } from '@nestjs/common';
import { AiAgentService } from '../common/ai-agent.service';
import { AgentApiKeyGuard } from '../common/api-key.guard';
import { JobsModule } from '../jobs/jobs.module';
import { McpModule } from '../mcp/mcp.module';
import { ResearchController } from './research.controller';
import { ResearchService } from './research.service';

@Module({
  imports: [McpModule, JobsModule],
  controllers: [ResearchController],
  providers: [ResearchService, AgentApiKeyGuard],
  exports: [ResearchService],
})
export class ResearchModule {}
