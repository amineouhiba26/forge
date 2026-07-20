import { randomUUID } from 'node:crypto';

import type { IncomingMessage } from 'node:http';

import { Params } from 'nestjs-pino';

import {
  currentCorrelationId,
  currentTenantId,
  hasCorrelationContext,
} from './correlation-context';

/**
 * One log shape for all five services.
 *
 * The backlog asks for "consistent log shape", and the reason is mechanical:
 * `grep` works on any format, but *filtering* — every error for one tenant,
 * every line for one correlation ID across five services — needs the same
 * field in the same place everywhere. A service that calls it `traceId` while
 * the others call it `correlationId` is invisible to the query that matters.
 */
export function buildLoggerConfig(serviceName: string): Params {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    pinoHttp: {
      name: serviceName,
      level: process.env.LOG_LEVEL ?? 'info',

      // Pretty-printed locally, JSON in production. JSON is what a log
      // aggregator ingests; pretty output is unparseable to it and essential
      // to a human reading a terminal.
      transport: isProduction
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,req,res',
            },
          },

      // Every line, not only request logs. This is what the async context in
      // `correlation-context.ts` buys — a log written deep inside a saga or a
      // job processor carries the ID without anyone threading it there.
      mixin() {
        // Omitted rather than invented when there is no correlation context.
        // Boot lines and background timers genuinely belong to no request, and
        // stamping them with a fresh UUID makes them *look* traceable while
        // joining nothing — noise that survives every grep for a real ID.
        if (!hasCorrelationContext()) {
          return { service: serviceName };
        }

        return {
          service: serviceName,
          correlationId: currentCorrelationId(),
          tenantId: currentTenantId(),
        };
      },

      // Nest's default is to log the full request and response objects, which
      // buries the message and leaks headers.
      serializers: {
        req: (request: { method: string; url: string }) => ({
          method: request.method,
          url: request.url,
        }),
        res: (response: { statusCode: number }) => ({
          statusCode: response.statusCode,
        }),
      },

      redact: {
        // Anything that could carry a credential. `authorization` is the
        // obvious one; the token fields matter because auth responses are
        // logged on the way out.
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.owner.password',
          'res.headers["set-cookie"]',
          '*.accessToken',
          '*.refreshToken',
          '*.passwordHash',
          '*.stripe-signature',
        ],
        censor: '[redacted]',
      },

      // Typed as the real `IncomingMessage`: a header can legitimately be
      // `string[]` when sent more than once, and a narrower signature would
      // not match pino-http's expected shape.
      genReqId: (request: IncomingMessage) => {
        const header = request.headers['x-correlation-id'];
        return (Array.isArray(header) ? header[0] : header) ?? randomUUID();
      },

      autoLogging: {
        // Health checks are polled every few seconds by the dashboard script
        // and would drown everything else.
        ignore: (request: IncomingMessage) =>
          request.url === '/health' || request.url === '/health/live',
      },
    },
  };
}
