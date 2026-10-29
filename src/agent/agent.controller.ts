import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AgentApiKeyGuard } from '../common/api-key.guard';
import { RunAgentDto } from '../dto/run-agent.dto';
import { AgentService } from './agent.service';

@Controller('agent')
@UseGuards(AgentApiKeyGuard)
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post('run')
  run(@Body() dto: RunAgentDto) {
    return this.agent.run(dto);
  }
}
