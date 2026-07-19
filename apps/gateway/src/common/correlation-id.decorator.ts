import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

/** Injects the correlation ID assigned by `CorrelationIdMiddleware`. */
export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<Request>().correlationId,
);
