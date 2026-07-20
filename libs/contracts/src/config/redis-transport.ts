import { Transport } from '@nestjs/microservices';
import type { RedisOptions } from '@nestjs/microservices';

import { TracePropagatingSerializer } from './trace-propagation';

/**
 * Transport options shared by every microservice and by the gateway's clients.
 *
 * Read straight from `process.env` rather than `ConfigService`, because Nest
 * needs these *before* `AppModule` initialises — and `ConfigService` only
 * exists once the module graph is up. That ordering is why every `main.ts`
 * starts with `import 'dotenv/config'`: without it these values are read
 * before `.env` is loaded and the port silently becomes `NaN`.
 *
 * The Joi schema inside each `AppModule` still runs a moment later, so a
 * missing var kills the process at boot either way; this just cannot be the
 * thing that reports it.
 */
export function buildRedisTransportOptions(): Required<
  Pick<RedisOptions, 'transport'>
> &
  RedisOptions {
  return {
    transport: Transport.REDIS,
    options: {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      // Keep retrying forever: a service that starts before Redis is ready
      // should wait, not die and take the compose stack down with it.
      retryAttempts: Number.POSITIVE_INFINITY,
      retryDelay: 1000,
      // Injects W3C trace context into every outgoing message, so a trace
      // spans services instead of stopping at each process boundary. Set here
      // rather than per-client so it covers every message, including ones
      // added later by someone who has not read the tracing code.
      serializer: new TracePropagatingSerializer(),
    },
  };
}
