import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

interface CorrelationStore {
  correlationId: string;
  tenantId?: string;
}

/**
 * Carries the correlation ID for the current logical operation.
 *
 * Sprint 5 threaded the ID through every method signature — command
 * constructors, event payloads, job data. That works for the paths that
 * remember to do it, and quietly loses the ID everywhere else: a log line
 * written three calls deep has no way to reach it.
 *
 * `AsyncLocalStorage` gives every async continuation of a request its own
 * store, so any code running underneath can read the ID without being handed
 * it. That is what lets the logger stamp *every* line rather than only the
 * ones that were passed a parameter.
 *
 * The explicit threading stays where it crosses a process boundary — an RPC
 * payload or a queued job — because async context does not survive Redis.
 */
const storage = new AsyncLocalStorage<CorrelationStore>();

/** Runs `fn` with a correlation context bound to it and everything it awaits. */
export function runWithCorrelation<T>(store: CorrelationStore, fn: () => T): T {
  return storage.run(store, fn);
}

/**
 * The current correlation ID, or a fresh one.
 *
 * Callers that need *an* ID — a job being enqueued outside a request, say —
 * get a usable one rather than having to handle undefined.
 *
 * Logging deliberately does not use this blindly: see the mixin in
 * `logger.config.ts`, which checks `hasCorrelationContext()` first and omits
 * the field entirely for boot lines and background work. A fabricated ID on a
 * line that belongs to no request looks traceable and joins nothing.
 */
export function currentCorrelationId(): string {
  return storage.getStore()?.correlationId ?? randomUUID();
}

/** The current tenant, when the operation has one. */
export function currentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

/** True when running inside a correlation context. */
export function hasCorrelationContext(): boolean {
  return storage.getStore() !== undefined;
}
