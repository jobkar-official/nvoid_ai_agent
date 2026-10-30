import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import configuration from './config/configuration';
import { ApplicationsModule } from './applications/applications.module';
import { HealthController } from './health.controller';
import { McpModule } from './mcp/mcp.module';
import { JobsModule } from './jobs/jobs.module';
import { AgentModule } from './agent/agent.module';
import { ResearchModule } from './research/research.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        prefix: configService.get<string>('queuePrefix', 'job-agent'),
        connection: {
          host: configService.get<string>('redis.host', '127.0.0.1'),
          port: configService.get<number>('redis.port', 6379),
          username: configService.get<string | undefined>('redis.username'),
          password: configService.get<string | undefined>('redis.password'),
          ...(configService.get<boolean>('redis.tls', false) ? { tls: {} } : {}),
          maxRetriesPerRequest: null,
        },
      }),
    }),
    McpModule,
    JobsModule,
    ApplicationsModule,
    AgentModule,
    ResearchModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
