/**
 * Queue and job names, shared between the producer (billing-service) and the
 * consumer (worker-service).
 *
 * These are the second kind of contract in this system. `patterns.ts` covers
 * request/response over Redis transport; this covers durable work handed to
 * BullMQ. The difference that matters: a message pattern with no subscriber is
 * a timeout, while a queued job with no worker simply waits — which is the
 * whole reason for moving PDF generation here in Sprint 5.
 */

export const QUEUES = {
  PDF: 'pdf',
  EMAIL: 'email',
} as const;

export const JOBS = {
  GENERATE_INVOICE_PDF: 'generate-invoice-pdf',
  SEND_INVOICE_EMAIL: 'send-invoice-email',
} as const;

/** Every job payload carries the correlation ID of the request that caused it. */
interface BaseJobData {
  correlationId: string;
  tenantId: string;
}

export interface GenerateInvoicePdfJobData extends BaseJobData {
  invoiceId: string;
}

export interface SendInvoiceEmailJobData extends BaseJobData {
  invoiceId: string;
  recipientEmail: string;
  recipientName: string;
  pdfPath: string;
  invoiceTotal: string;
  currency: string;
}

/**
 * Retry policy, shared so the producer's expectation and the DLQ threshold
 * cannot drift apart.
 *
 * Exponential backoff rather than fixed: a downstream that is failing because
 * it is overloaded gets worse under a fixed-interval retry storm. Doubling
 * gives it room to recover — 2s, 4s, 8s, 16s, 32s.
 */
export const JOB_RETRY_POLICY = {
  attempts: 5,
  backoff: {
    type: 'exponential' as const,
    delay: 2000,
  },
  /**
   * Completed jobs are kept briefly for inspection, then trimmed — Redis is
   * memory, and an unbounded completed set is a slow leak.
   */
  removeOnComplete: { age: 3600, count: 1000 },
  /**
   * Failed jobs are NOT auto-removed. They are written to dead_letter_jobs on
   * exhaustion, and keeping the Redis copy alongside makes replay easier while
   * it lasts.
   */
  removeOnFail: false,
} as const;
