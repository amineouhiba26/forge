// Loads .env into process.env before ANY module is imported. Transport options
// and the Prisma adapter read process.env at module-load time, which happens
// before ConfigModule gets a chance to run. In Docker/CI this is a no-op --
// the environment is already populated.
import 'dotenv/config';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties and reject payloads that carry them, so a
      // client cannot smuggle fields past a DTO into a downstream service.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port);
  Logger.log(`gateway listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
