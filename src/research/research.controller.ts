import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AgentApiKeyGuard } from '../common/api-key.guard';
import { ResearchRunDto } from './research.dto';
import { ResearchService } from './research.service';

@Controller('research')
@UseGuards(AgentApiKeyGuard)
export class ResearchController {
  constructor(private readonly research: ResearchService) {}

  @Get('tools')
  tools() {
    return this.research.listTools();
  }

  @Post('run')
  run(@Body() dto: ResearchRunDto) {
    return this.research.run(dto);
  }
}
