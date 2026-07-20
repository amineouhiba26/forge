import { randomUUID } from 'node:crypto';

import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { runWithCorrelation } from './correlation-context';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

declare module 'express-serve-static-core' {
  interface Request {
    correlationId: string;
  }
}

/**
 * Assigns one correlation ID per HTTP request and binds it to the async
 * context for everything the request goes on to do.
 *
 * Moved here from the gateway in Sprint 6, which is what the backlog asks for
 * ("formalised as a shared lib, applied everywhere"). The gateway is still the
 * only HTTP entry point, so it is the only current user — but the ID's
 * *lifetime* is now a platform concern rather than a gateway one, and the
 * async-context binding below is what every other service depends on.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const inbound = request.header(CORRELATION_ID_HEADER);

    // An inbound ID is honoured so a trace can span systems, but validated
    // first: the value reaches logs and response headers, so accepting
    // arbitrary client input invites log injection and unbounded strings.
    const correlationId =
      inbound && UUID_PATTERN.test(inbound) ? inbound : randomUUID();

    request.correlationId = correlationId;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);

    // `next()` runs *inside* the store, so every handler, guard, interceptor
    // and service call underneath sees this ID without being passed it.
    runWithCorrelation({ correlationId }, () => next());
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
