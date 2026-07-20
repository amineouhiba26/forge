import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * One log line per request, stamped with the correlation ID.
 *
 * Without this the gateway is invisible in a trace: it generates the ID and
 * forwards it, but never writes it anywhere. The Sprint 5 Definition of Done
 * is that grepping one ID shows the journey across *gateway*, billing and
 * worker — and the gateway end was missing until this existed.
 *
 * Sprint 6 replaces this with `nestjs-pino` and structured output across all
 * five services. The value here is that the entry point appears in the trace
 * at all.
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const { method, originalUrl, correlationId } = request;
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log(
            `${method} ${originalUrl} ${response.statusCode} ` +
              `${Date.now() - startedAt}ms (correlationId=${correlationId})`,
          );
        },
        // Logged on the error path too — a request that fails auth or 500s is
        // exactly the one worth being able to trace.
        error: (error: { status?: number }) => {
          this.logger.warn(
            `${method} ${originalUrl} ${error?.status ?? 500} ` +
              `${Date.now() - startedAt}ms (correlationId=${correlationId})`,
          );
        },
      }),
    );
  }
}
