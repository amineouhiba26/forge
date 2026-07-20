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
  // `rawBody: true` keeps the untouched request bytes on `req.rawBody`
  // alongside the parsed body. The Stripe webhook needs them: the signature is
  // computed over exactly what was sent, and parse-then-re-serialise does not
  // reliably reproduce it (key order, whitespace, number formatting). Without
  // this, a genuine webhook fails verification.
  const app = await NestFactory.create(AppModule, { rawBody: true });

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
