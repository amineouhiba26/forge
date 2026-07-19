// Loads .env into process.env before ANY module is imported. Transport options
// and the Prisma adapter read process.env at module-load time, which happens
// before ConfigModule gets a chance to run. In Docker/CI this is a no-op --
// the environment is already populated.
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Logger } from '@nestjs/common';

import { buildRedisTransportOptions } from '@forge/contracts';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    buildRedisTransportOptions(),
  );

  await app.listen();
  Logger.log('tenants-service listening on Redis transport', 'Bootstrap');
}

void bootstrap();
