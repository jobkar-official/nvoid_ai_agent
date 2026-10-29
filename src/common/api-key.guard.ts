import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

@Injectable()
export class AgentApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('agentApiKey', '');
    if (!expected) {
      throw new ServiceUnavailableException('AGENT_API_KEY must be configured before using protected endpoints.');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header('x-agent-api-key') ?? request.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);

    if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
      throw new UnauthorizedException('Invalid agent API key.');
    }

    return true;
  }
}
