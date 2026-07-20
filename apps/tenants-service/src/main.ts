// Loads .env into process.env before ANY module is imported. Transport options
// and the Prisma adapter read process.env at module-load time, which happens
// before ConfigModule gets a chance to run. In Docker/CI this is a no-op --
// the environment is already populated.
import 'dotenv/config';

// Tracing starts before any other import. OpenTelemetry patches modules as
// they load, so anything already required is never instrumented and silently
// produces no spans.
import { startTracing } from '@forge/observability';

const tracing = startTracing('tenants-service');

import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';

import { buildRedisTransportOptions } from '@forge/contracts';

import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    { ...buildRedisTransportOptions(), bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  await app.listen();
  app.get(Logger).log('tenants-service listening on Redis transport');

  const stop = () => void tracing.shutdown().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void bootstrap();
