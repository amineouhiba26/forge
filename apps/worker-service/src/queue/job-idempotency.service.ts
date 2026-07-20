import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '@forge/prisma';

/** How long a CLAIMED row is trusted before it is treated as abandoned. */
const CLAIM_STALE_AFTER_MS = 5 * 60 * 1000;

export type ClaimResult =
  | { proceed: true }
  | { proceed: false; reason: 'already-completed' | 'in-progress' };

/**
 * Stops a reprocessed job from repeating its side effect.
 *
 * BullMQ delivers a job at least once. A worker that does the work and then
 * crashes before acknowledging leaves the job to be retried — and for an email
 * that means the client receives the same invoice twice.
 *
 * **Exactly-once does not exist across a network boundary.** Sending an email
 * and recording that it was sent are two separate systems, and no ordering of
 * them removes the window:
 *
 * - Record first, then send → a crash in between means the email is never sent
 *   and never retried. **Silent non-delivery.**
 * - Send first, then record → a crash in between means it is sent twice.
 *   **Visible duplicate.**
 *
 * This picks the second, deliberately: for an invoice, a duplicate is an
 * annoyance and a missing one means you do not get paid. The claim row narrows
 * the window to the milliseconds between sending and recording, rather than
 * leaving it open for the whole job.
 */
@Injectable()
export class JobIdempotencyService {
  private readonly logger = new Logger(JobIdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Attempts to claim a job key.
   *
   * The unique constraint decides, not a read — a `findUnique` followed by a
   * `create` is two statements, and two workers pulling the same job would
   * both see nothing before either wrote.
   */
  async claim(jobKey: string, tenantId: string): Promise<ClaimResult> {
    try {
      await this.prisma.processedJob.create({
        data: { jobKey, tenantId, state: 'CLAIMED' },
      });

      return { proceed: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await this.prisma.processedJob.findUnique({
      where: { jobKey },
    });

    if (!existing) {
      // Raced with a delete — vanishingly unlikely, and retrying the claim is
      // the safe response rather than assuming either outcome.
      return { proceed: true };
    }

    if (existing.state === 'COMPLETED') {
      this.logger.log(`Job ${jobKey} already completed — skipping`);
      return { proceed: false, reason: 'already-completed' };
    }

    // A CLAIMED row that is still fresh means another worker is on it right
    // now; backing off avoids two workers emailing simultaneously.
    const claimAge = Date.now() - existing.claimedAt.getTime();

    if (claimAge < CLAIM_STALE_AFTER_MS) {
      this.logger.warn(`Job ${jobKey} is claimed and in progress — skipping`);
      return { proceed: false, reason: 'in-progress' };
    }

    // A stale claim means the previous worker died mid-job. Without this the
    // job would be stuck forever behind its own abandoned claim, which is
    // worse than the risk of a duplicate.
    this.logger.warn(
      `Job ${jobKey} has a stale claim (${Math.round(claimAge / 1000)}s old) — reclaiming`,
    );
    await this.prisma.processedJob.update({
      where: { jobKey },
      data: { claimedAt: new Date() },
    });

    return { proceed: true };
  }

  /** Marks the side effect as done. Called only after it actually happened. */
  async complete(jobKey: string): Promise<void> {
    await this.prisma.processedJob.update({
      where: { jobKey },
      data: { state: 'COMPLETED', completedAt: new Date() },
    });
  }

  /**
   * Drops a claim after a failure, so BullMQ's own retry is not blocked by the
   * claim its previous attempt left behind.
   */
  async release(jobKey: string): Promise<void> {
    await this.prisma.processedJob
      .delete({ where: { jobKey } })
      .catch(() => undefined);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}
