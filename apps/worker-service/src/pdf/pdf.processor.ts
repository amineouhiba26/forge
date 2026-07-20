import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Job } from 'bullmq';

import { EVENTS, JOB_RETRY_POLICY, QUEUES } from '@forge/contracts';
import type {
  GenerateInvoicePdfJobData,
  InvoicePdfFailedPayload,
  InvoicePdfGeneratedPayload,
} from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

import { BILLING_CLIENT } from '../rpc/rpc-clients.module';
import { DeadLetterService } from '../queue/dead-letter.service';
import { PdfRendererService } from './pdf-renderer.service';

@Processor(QUEUES.PDF)
export class PdfProcessor extends WorkerHost {
  private readonly logger = new Logger(PdfProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: PdfRendererService,
    private readonly deadLetter: DeadLetterService,
    @Inject(BILLING_CLIENT) private readonly billing: ClientProxy,
  ) {
    super();
  }

  async process(
    job: Job<GenerateInvoicePdfJobData>,
  ): Promise<{ pdfPath: string }> {
    const { invoiceId, tenantId, correlationId } = job.data;

    this.logger.log(
      `Rendering PDF for invoice ${invoiceId} ` +
        `(attempt ${job.attemptsMade + 1}/${JOB_RETRY_POLICY.attempts}, ` +
        `correlationId=${correlationId})`,
    );

    // No idempotency claim here, unlike the email job. The filename is
    // deterministic, so a retry overwrites identical bytes — the operation is
    // naturally idempotent and a claim would only add a failure mode.
    const invoice = await this.prisma.forTenant(tenantId, (tx) =>
      tx.invoice.findUnique({ where: { id: invoiceId } }),
    );

    if (!invoice) {
      // Non-retryable: the invoice will not appear on attempt five. Throwing
      // still consumes retries, which is wasteful but harmless — and far safer
      // than swallowing it, which would leave the invoice PENDING forever.
      throw new Error(`Invoice ${invoiceId} not found`);
    }

    const [tenant, client] = await this.prisma.forTenant(tenantId, (tx) =>
      Promise.all([
        tx.tenant.findUnique({ where: { id: tenantId } }),
        tx.client.findUnique({ where: { id: invoice.clientId } }),
      ]),
    );

    const pdfPath = await this.renderer.renderInvoice(tenantId, {
      invoiceId,
      tenantName: tenant?.name ?? 'Unknown',
      clientName: client?.name ?? 'Unknown',
      clientEmail: client?.email ?? '',
      subtotal: invoice.subtotal.toFixed(2),
      taxRate: invoice.taxRate.toFixed(2),
      taxAmount: invoice.taxAmount.toFixed(2),
      total: invoice.total.toFixed(2),
      currency: invoice.currency,
      issuedAt: new Date().toISOString().slice(0, 10),
    });

    // Fire-and-forget back to billing. `emit`, not `send`: nothing is waiting
    // on a reply, and billing subscribing is not this processor's concern.
    this.billing.emit<void, InvoicePdfGeneratedPayload>(
      EVENTS.INVOICE_PDF_GENERATED,
      { tenantId, invoiceId, pdfPath, correlationId },
    );

    this.logger.log(
      `PDF ready for invoice ${invoiceId} at ${pdfPath} ` +
        `(correlationId=${correlationId})`,
    );

    return { pdfPath };
  }

  /**
   * Fires only once retries are exhausted — BullMQ calls this on every failed
   * attempt, so the attempt count is what distinguishes "will retry" from
   * "gave up".
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<GenerateInvoicePdfJobData>,
    error: Error,
  ): Promise<void> {
    const { invoiceId, tenantId, correlationId } = job.data;

    if (job.attemptsMade < JOB_RETRY_POLICY.attempts) {
      this.logger.warn(
        `PDF attempt ${job.attemptsMade} failed for invoice ${invoiceId}: ` +
          `${error.message} — will retry (correlationId=${correlationId})`,
      );
      return;
    }

    await this.deadLetter.record(QUEUES.PDF, job, error);

    // Billing has to hear about this, or the invoice sits in PENDING forever.
    // The compensating path from Sprint 3 is still there — it is now driven by
    // an event from the queue rather than by a failed RPC.
    this.billing.emit<void, InvoicePdfFailedPayload>(
      EVENTS.INVOICE_PDF_FAILED,
      {
        tenantId,
        invoiceId,
        reason: error.message,
        attempts: job.attemptsMade,
        correlationId,
      },
    );
  }
}
