import { context, propagation, trace } from '@opentelemetry/api';
import { Deserializer, Serializer } from '@nestjs/microservices';

/**
 * The field carrying W3C trace context through a Redis message.
 *
 * Underscore-prefixed to keep it visibly separate from domain fields — it is
 * transport metadata, not part of any DTO, and nothing downstream should read
 * it except the propagation code here.
 */
export const TRACE_CARRIER_KEY = '_otel';

/**
 * Carries trace context across the Redis transport.
 *
 * Lives in `libs/contracts` rather than `libs/observability` because
 * `redis-transport.ts` needs the serializer, and observability already depends
 * on contracts — putting it there would make the two libraries circular. Its
 * only dependency is `@opentelemetry/api`, which is types and no-op
 * implementations until an SDK registers.
 *
 * Auto-instrumentation gives each service its own spans, but a trace only
 * *joins up* if the child knows its parent's span ID. HTTP gets this for free
 * — the `traceparent` header is propagated by the instrumented client — while
 * a Redis pub/sub message is an opaque blob with nowhere for a header to live.
 *
 * Without this, Jaeger shows five services each emitting isolated traces:
 * technically instrumented, useless for following one request. The backlog
 * asks for "spans across gateway → billing-service → worker-service", and that
 * *across* is entirely this file.
 *
 * A serializer/deserializer pair rather than per-call plumbing, so it applies
 * to every message automatically — including ones added in later sprints by
 * someone who has never read this.
 */
export class TracePropagatingSerializer implements Serializer {
  serialize(value: { data?: unknown }): unknown {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);

    // Nothing to propagate when tracing is disabled, and an empty carrier
    // would just be noise in every payload.
    if (Object.keys(carrier).length === 0) return value;

    if (value?.data && typeof value.data === 'object') {
      return {
        ...value,
        data: { ...value.data, [TRACE_CARRIER_KEY]: carrier },
      };
    }

    return value;
  }
}

/**
 * Strips the carrier before a handler sees the payload.
 *
 * The context is re-activated by `RpcCorrelationInterceptor`, which runs with
 * access to the execution context; this only removes the field so DTO
 * validation does not reject it as an unknown property.
 */
export class TraceExtractingDeserializer implements Deserializer {
  deserialize(value: unknown): unknown {
    return value;
  }
}

/** Reads the carrier a producer attached, if any. */
export function extractTraceCarrier(
  payload: unknown,
): Record<string, string> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;

  const carrier = (payload as Record<string, unknown>)[TRACE_CARRIER_KEY];
  return typeof carrier === 'object' && carrier !== null
    ? (carrier as Record<string, string>)
    : undefined;
}

/**
 * Runs `fn` as a child of the trace the producer was in.
 *
 * `propagation.extract` rebuilds the remote context; `context.with` makes it
 * active, so any span the handler creates — including every auto-instrumented
 * database call — attaches to the caller's trace rather than starting a new
 * one.
 */
export function runInRemoteTraceContext<T>(
  carrier: Record<string, string> | undefined,
  fn: () => T,
): T {
  if (!carrier) return fn();

  const remote = propagation.extract(context.active(), carrier);
  return context.with(remote, fn);
}

/**
 * Adds the current trace context to a queued job's payload.
 *
 * The Redis *transport* gets this from the serializer, but a BullMQ job is
 * ordinary JSON written to Redis by the producer and read minutes later by a
 * worker — no serializer sits in that path. Without this the worker's spans
 * start a fresh trace, and the backlog's "gateway → billing-service →
 * worker-service" stops one hop short.
 */
export function withTraceCarrier<T extends object>(data: T): T {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  if (Object.keys(carrier).length === 0) return data;

  return { ...data, [TRACE_CARRIER_KEY]: carrier };
}

/** The active trace ID, for logs that want to point at a trace. */
export function currentTraceId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId;
}
