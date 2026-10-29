import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsObject } from 'class-validator';
import { AgentApiKeyGuard } from '../common/api-key.guard';
import { McpRegistryService } from './mcp-registry.service';

class CallMcpToolDto {
  @IsObject()
  arguments!: Record<string, unknown>;
}

@Controller('mcp')
@UseGuards(AgentApiKeyGuard)
export class McpController {
  constructor(private readonly registry: McpRegistryService) {}

  @Get('servers')
  servers() {
    return { servers: this.registry.getStatuses() };
  }

  @Get('tools')
  tools() {
    return { servers: this.registry.getToolCatalog() };
  }

  @Get(':serverId/tools')
  toolsForServer(@Param('serverId') serverId: string) {
    return { servers: this.registry.getToolCatalog(serverId) };
  }

  @Post(':serverId/tools/:toolName/call')
  callTool(
    @Param('serverId') serverId: string,
    @Param('toolName') toolName: string,
    @Body() dto: CallMcpToolDto,
  ) {
    return this.registry.callTool(serverId, toolName, dto.arguments ?? {});
  }
}
