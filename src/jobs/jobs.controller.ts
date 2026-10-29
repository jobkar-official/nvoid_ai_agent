import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AgentApiKeyGuard } from '../common/api-key.guard';
import { SearchJobsDto } from '../dto/search-jobs.dto';
import { JobDiscoveryService } from './job-discovery.service';

@Controller('jobs')
@UseGuards(AgentApiKeyGuard)
export class JobsController {
  constructor(private readonly discovery: JobDiscoveryService) {}

  @Post('search')
  search(@Body() dto: SearchJobsDto) {
    return this.discovery.search(dto.profile, dto.limit ?? 100, dto.serverIds, dto.syncToBackend !== false);
  }
}
