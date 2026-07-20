// Loads .env into process.env before ANY module is imported. Transport options
// and the Prisma adapter read process.env at module-load time, which happens
// before ConfigModule gets a chance to run. In Docker/CI this is a no-op --
// the environment is already populated.
import 'dotenv/config';

// Tracing starts before any other import. OpenTelemetry patches modules as
// they load, so anything already required is never instrumented and silently
// produces no spans.
import { startTracing } from '@forge/observability';

const tracing = startTracing('gateway');

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // `rawBody: true` keeps the untouched request bytes on `req.rawBody`
  // alongside the parsed body. The Stripe webhook needs them: the signature is
  // computed over exactly what was sent, and parse-then-re-serialise does not
  // reliably reproduce it (key order, whitespace, number formatting). Without
  // this, a genuine webhook fails verification.
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    // Nest's own logger is buffered until pino takes over, so startup lines
    // are not lost and are not written in a second format.
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

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
  app.get(Logger).log(`gateway listening on http://localhost:${port}`);

  // Flush pending spans on shutdown, or the last seconds of traces before
  // every deploy are lost.
  const stop = () => void tracing.shutdown().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void bootstrap();
