import { Module } from '@nestjs/common';
import { AgentApiKeyGuard } from '../common/api-key.guard';
import { ApplicationsModule } from '../applications/applications.module';
import { JobsModule } from '../jobs/jobs.module';
import { McpModule } from '../mcp/mcp.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';

@Module({
  imports: [JobsModule, ApplicationsModule, McpModule],
  controllers: [AgentController],
  providers: [AgentService, AgentApiKeyGuard],
})
export class AgentModule {}
