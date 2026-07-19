import { randomUUID } from 'node:crypto';

import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Widened on the Express request so handlers can read it without casting. */
declare module 'express-serve-static-core' {
  interface Request {
    correlationId: string;
  }
}

/**
 * Assigns one ID per HTTP request, to be carried through every downstream hop.
 *
 * An inbound `x-correlation-id` is honoured so a trace can span systems, and it
 * is validated as a UUID before being trusted — the value is echoed into
 * response headers and logs, so accepting arbitrary client input would allow
 * log injection (forged newlines fabricating log lines) and unbounded strings.
 *
 * By Sprint 6 this becomes a shared library applied across all five services.
 * It lives in the gateway for now because the gateway is the only HTTP entry
 * point, and so the only place a request *begins*.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const inbound = request.header(CORRELATION_ID_HEADER);

    request.correlationId =
      inbound && UUID_PATTERN.test(inbound) ? inbound : randomUUID();

    // Echoed back so a caller can correlate its own logs with ours without
    // having to parse a response body.
    response.setHeader(CORRELATION_ID_HEADER, request.correlationId);

    next();
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
