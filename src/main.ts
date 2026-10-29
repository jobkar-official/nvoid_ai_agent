import 'dotenv/config';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  app.use(helmet());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  }));

  const origins = (process.env.FRONTEND_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  if (origins.length > 0) {
    app.enableCors({ origin: origins, methods: ['GET', 'POST'], allowedHeaders: ['content-type', 'x-agent-api-key', 'authorization'] });
  }

  app.enableShutdownHooks();
  const port = config.get<number>('port', 3100);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
