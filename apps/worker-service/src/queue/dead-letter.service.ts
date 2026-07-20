import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { Prisma, PrismaService } from '@forge/prisma';

/** The minimum every queued payload carries. */
export interface DeadLetterableJobData {
  tenantId?: string;
  correlationId?: string;
}

/**
 * Records jobs that exhausted their retries.
 *
 * The backlog's requirement is that a job failing after N retries is not
 * silently dropped. BullMQ does keep failed jobs, but it keeps them in Redis —
 * which is memory, gets flushed, and has an eviction policy. "Which invoices
 * never reached a client?" has to stay answerable after that.
 */
@Injectable()
export class DeadLetterService {
  private readonly logger = new Logger(DeadLetterService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Accepts any job whose payload carries the two fields every job in this
   * system has. Typed structurally rather than as `Record<string, unknown>`,
   * which the concrete job interfaces are not assignable to (no index
   * signature) — and rather than `any`, which would drop the guarantee that a
   * dead letter can always be traced.
   */
  async record(
    queueName: string,
    job: Job<DeadLetterableJobData>,
    error: Error,
  ): Promise<void> {
    const { tenantId, correlationId } = job.data;

    // Logged at error level with the correlation ID, so the DLQ write is
    // visible in the same trace as the work that failed.
    this.logger.error(
      `DEAD LETTER: ${queueName}/${job.name} job ${job.id} failed after ` +
        `${job.attemptsMade} attempts: ${error.message} ` +
        `(correlationId=${correlationId})`,
    );

    if (!tenantId) {
      // dead_letter_jobs enforces RLS, so a row cannot be written without a
      // tenant context. A job with no tenant is a programming error rather
      // than an operational one — surface it rather than dropping it.
      this.logger.error(
        `Cannot persist dead letter for job ${job.id}: no tenantId in payload`,
      );
      return;
    }

    try {
      await this.prisma.forTenant(tenantId, (tx) =>
        tx.deadLetterJob.create({
          data: {
            queueName,
            jobName: job.name,
            jobId: String(job.id),
            // The full payload, so the job can be replayed by hand once the
            // underlying cause is fixed.
            //
            // Cast because the column accepts JSON values, and an interface
            // without an index signature is not assignable to `InputJsonValue`
            // even when every field it holds is JSON-safe.
            payload: job.data as unknown as Prisma.InputJsonValue,
            failedReason: error.message,
            stackTrace: error.stack ?? null,
            attempts: job.attemptsMade,
            correlationId: correlationId ?? null,
            tenantId,
          },
        }),
      );
    } catch (writeError) {
      // Never rethrow. This runs inside a failure handler — throwing here
      // would replace a recorded failure with an unrecorded one.
      this.logger.error(
        `Failed to persist dead letter for job ${job.id}: ` +
          `${(writeError as Error).message}`,
      );
    }
  }
}
