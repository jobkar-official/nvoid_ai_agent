import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AgentApiKeyGuard } from '../common/api-key.guard';
import { EnqueueApplicationsDto } from '../dto/enqueue-applications.dto';
import { ApplicationQueueService } from './application-queue.service';

@Controller('applications')
@UseGuards(AgentApiKeyGuard)
export class ApplicationsController {
  constructor(private readonly queue: ApplicationQueueService) {}

  @Post('enqueue')
  enqueue(@Body() dto: EnqueueApplicationsDto) {
    return this.queue.enqueue(dto);
  }

  @Get('tasks')
  recent(@Query('limit') limit?: string) {
    return this.queue.getRecent(Number.parseInt(limit ?? '50', 10) || 50);
  }

  @Get('tasks/:taskId')
  status(@Param('taskId') taskId: string) {
    return this.queue.getStatus(taskId);
  }
}
