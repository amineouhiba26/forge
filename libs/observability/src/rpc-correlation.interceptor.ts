import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';

import { runWithCorrelation } from './correlation-context';
import { extractTraceCarrier, runInRemoteTraceContext } from '@forge/contracts';

interface EnvelopedPayload {
  correlationId?: string;
  tenantId?: string;
}

/**
 * Rebinds the correlation context on the *receiving* side of an RPC or event.
 *
 * Async context does not cross a process boundary — Redis carries bytes, not
 * an `AsyncLocalStorage` store. So the ID travels in the message payload
 * (Sprint 0's message envelope), and this interceptor unpacks it back into
 * context as the message is handled.
 *
 * Without this, a downstream service's logs carry no correlation ID at all
 * unless every log call is manually passed one — which is exactly the
 * threading the shared context exists to remove.
 */
@Injectable()
export class RpcCorrelationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const payload = context.switchToRpc().getData<EnvelopedPayload>();

    // Re-activate the caller's trace first, so any span this handler creates —
    // including auto-instrumented database calls — attaches to the caller's
    // trace rather than starting an orphan.
    const carrier = extractTraceCarrier(payload);

    if (!payload?.correlationId) {
      // Nothing to bind. Health pings and a few internal messages have no
      // envelope, and inventing an ID here would produce a trace fragment
      // that joins nothing.
      return runInRemoteTraceContext(carrier, () => next.handle());
    }

    // Captured before the closures: TypeScript's narrowing from the guard
    // above does not survive into a callback.
    const { correlationId, tenantId } = payload;

    return runInRemoteTraceContext(carrier, () =>
      runWithCorrelation({ correlationId, tenantId }, () => next.handle()),
    );
  }
}
