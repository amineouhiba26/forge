import { extractTraceCarrier, runInRemoteTraceContext } from '@forge/contracts';
import { runWithCorrelation } from '@forge/observability';

interface TracedJobData {
  correlationId?: string;
  tenantId?: string;
}

/**
 * Re-establishes the producer's trace and correlation context for a job.
 *
 * A queued job is the one boundary where *both* mechanisms have to be restored
 * by hand. The RPC transport has a serializer for traces and an interceptor
 * for correlation; a BullMQ job is plain JSON that a worker picks up minutes
 * later, in a process that was not running when the request arrived.
 *
 * Without this the worker's logs carry no correlation ID and its spans start a
 * fresh trace — the job runs correctly and is invisible to every tool used to
 * find out why something took so long.
 */
export function runInJobContext<T>(data: TracedJobData, fn: () => T): T {
  const carrier = extractTraceCarrier(data);

  return runInRemoteTraceContext(carrier, () => {
    if (!data.correlationId) return fn();

    return runWithCorrelation(
      { correlationId: data.correlationId, tenantId: data.tenantId },
      fn,
    );
  });
}
