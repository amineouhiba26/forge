import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Job } from 'bullmq';

import { EVENTS, JOB_RETRY_POLICY, QUEUES } from '@forge/contracts';
import type {
  InvoiceEmailSentPayload,
  SendInvoiceEmailJobData,
} from '@forge/contracts';

import { DeadLetterService } from '../queue/dead-letter.service';
import { runInJobContext } from '../queue/job-context';
import { JobIdempotencyService } from '../queue/job-idempotency.service';
import { BILLING_CLIENT } from '../rpc/rpc-clients.module';
import { MailService } from './mail.service';

/**
 * Derived from what the job *does*, not from the BullMQ job id.
 *
 * A retry gets a fresh attempt but must produce the same key, or the dedupe
 * check can never match and every retry sends another email.
 */
export function emailJobKey(invoiceId: string): string {
  return `email:invoice-issued:${invoiceId}`;
}

@Processor(QUEUES.EMAIL)
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    private readonly mail: MailService,
    private readonly idempotency: JobIdempotencyService,
    private readonly deadLetter: DeadLetterService,
    @Inject(BILLING_CLIENT) private readonly billing: ClientProxy,
  ) {
    super();
  }

  /** See PdfProcessor.process — same reason, same wrapper. */
  process(job: Job<SendInvoiceEmailJobData>): Promise<{ sent: boolean }> {
    return runInJobContext(job.data, () => this.handle(job));
  }

  private async handle(
    job: Job<SendInvoiceEmailJobData>,
  ): Promise<{ sent: boolean }> {
    const { invoiceId, tenantId, correlationId, recipientEmail } = job.data;
    const jobKey = emailJobKey(invoiceId);

    this.logger.log(
      `Sending invoice ${invoiceId} to ${recipientEmail} ` +
        `(attempt ${job.attemptsMade + 1}/${JOB_RETRY_POLICY.attempts}, ` +
        `correlationId=${correlationId})`,
    );

    const claim = await this.idempotency.claim(jobKey, tenantId);

    if (!claim.proceed) {
      // Reported as success. The desired state — this client has the invoice —
      // already holds, and failing would make the queue retry a job whose
      // effect is already in place.
      this.logger.log(
        `Skipping duplicate email for invoice ${invoiceId} (${claim.reason}) ` +
          `(correlationId=${correlationId})`,
      );
      return { sent: false };
    }

    try {
      await this.mail.sendInvoice({
        to: recipientEmail,
        recipientName: job.data.recipientName,
        invoiceId,
        total: job.data.invoiceTotal,
        currency: job.data.currency,
        pdfPath: job.data.pdfPath,
      });
    } catch (error) {
      // The claim is dropped so BullMQ's retry is not blocked by the claim its
      // own previous attempt left behind — otherwise the first SMTP failure
      // would deadlock every subsequent attempt against "in-progress".
      await this.idempotency.release(jobKey);
      throw error;
    }

    // Only after the send actually returned. The gap between these two lines
    // is the irreducible duplicate window — see JobIdempotencyService for why
    // this ordering is the right side of the trade.
    await this.idempotency.complete(jobKey);

    this.logger.log(
      `Invoice ${invoiceId} email sent to ${recipientEmail} ` +
        `(correlationId=${correlationId})`,
    );

    this.billing.emit<void, InvoiceEmailSentPayload>(
      EVENTS.INVOICE_EMAIL_SENT,
      { tenantId, invoiceId, recipientEmail, correlationId },
    );

    return { sent: true };
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<SendInvoiceEmailJobData>,
    error: Error,
  ): Promise<void> {
    const { invoiceId, correlationId } = job.data;

    if (job.attemptsMade < JOB_RETRY_POLICY.attempts) {
      // Backoff is exponential, so these are 2s, 4s, 8s, 16s apart. A fixed
      // interval would hammer an SMTP server that is failing *because* it is
      // overloaded.
      this.logger.warn(
        `Email attempt ${job.attemptsMade} failed for invoice ${invoiceId}: ` +
          `${error.message} — will retry (correlationId=${correlationId})`,
      );
      return;
    }

    // Exhausted. Recorded durably rather than left in Redis, so "which clients
    // never received their invoice?" survives a Redis flush.
    await this.deadLetter.record(QUEUES.EMAIL, job, error);
  }
}
