/**
 * Fire-and-forget event names (emitted via `ClientProxy.emit`, not `send`).
 *
 * Kept separate from RPC patterns in `patterns.ts` on purpose: an event has no
 * caller waiting on a reply, so adding a new subscriber is a safe change while
 * changing an RPC signature is a breaking one. Mixing them in one file makes
 * that distinction easy to lose.
 *
 * Naming convention: `<resource>.<past-tense-verb>`
 */

export const EVENTS = {
  SERVICE_STARTED: 'service.started',

  /**
   * Emitted by worker-service once a PDF job finishes. Billing subscribes and
   * moves the invoice to ISSUED.
   *
   * An event rather than an RPC reply: the job is durable and asynchronous, so
   * there is no caller still waiting. This is the coupling Sprint 3 accepted
   * deliberately and Sprint 5 removes.
   */
  INVOICE_PDF_GENERATED: 'invoice.pdf.generated',
  /** Emitted when a PDF job exhausts its retries. */
  INVOICE_PDF_FAILED: 'invoice.pdf.failed',
  /** Emitted once an invoice email is confirmed sent. */
  INVOICE_EMAIL_SENT: 'invoice.email.sent',
} as const;

export interface InvoicePdfGeneratedPayload {
  tenantId: string;
  invoiceId: string;
  pdfPath: string;
  correlationId: string;
}

export interface InvoicePdfFailedPayload {
  tenantId: string;
  invoiceId: string;
  reason: string;
  attempts: number;
  correlationId: string;
}

export interface InvoiceEmailSentPayload {
  tenantId: string;
  invoiceId: string;
  recipientEmail: string;
  correlationId: string;
}

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
