import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BackendSyncService } from '../common/backend-sync.service';
import { AiAgentService } from '../common/ai-agent.service';
import { AgentApiKeyGuard } from '../common/api-key.guard';
import { McpModule } from '../mcp/mcp.module';
import { APPLICATION_QUEUE } from './application.constants';
import { ApplicationExecutorService } from './application-executor.service';
import { ApplicationProcessor } from './application-processor';
import { DomainLockService } from './domain-lock.service';
import { ApplicationQueueService } from './application-queue.service';
import { ApplicationsController } from './applications.controller';

@Module({
  imports: [McpModule, BullModule.registerQueue({ name: APPLICATION_QUEUE })],
  controllers: [ApplicationsController],
  providers: [ApplicationQueueService, ApplicationExecutorService, ApplicationProcessor, DomainLockService, BackendSyncService, AiAgentService, AgentApiKeyGuard],
  exports: [ApplicationQueueService],
})
export class ApplicationsModule {}
