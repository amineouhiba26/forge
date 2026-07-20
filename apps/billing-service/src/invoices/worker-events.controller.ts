import { Controller, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { EventPattern, Payload } from '@nestjs/microservices';

import { EVENTS } from '@forge/contracts';
import type {
  InvoiceEmailSentPayload,
  InvoicePdfFailedPayload,
  InvoicePdfGeneratedPayload,
} from '@forge/contracts';

import {
  MarkGenerationFailedCommand,
  MarkInvoiceIssuedCommand,
} from './commands/create-invoice.command';

/**
 * Outcomes reported by worker-service.
 *
 * `@EventPattern`, not `@MessagePattern`: the worker is announcing something
 * that already happened and is not waiting for a reply. Nest does not send one
 * back, so a slow handler here cannot stall the worker.
 *
 * This is the half of the Sprint 3 → Sprint 5 rework that replaces the RPC's
 * return value. The compensating path is unchanged in meaning — the invoice
 * still ends in GENERATION_FAILED with a reason — only its trigger moved from
 * a rejected promise to an inbound event.
 */
@Controller()
export class WorkerEventsController {
  private readonly logger = new Logger(WorkerEventsController.name);

  constructor(private readonly commandBus: CommandBus) {}

  @EventPattern(EVENTS.INVOICE_PDF_GENERATED)
  async onPdfGenerated(
    @Payload() payload: InvoicePdfGeneratedPayload,
  ): Promise<void> {
    this.logger.log(
      `PDF ready for invoice ${payload.invoiceId} ` +
        `(correlationId=${payload.correlationId})`,
    );

    await this.commandBus.execute(
      new MarkInvoiceIssuedCommand(
        payload.tenantId,
        payload.invoiceId,
        payload.pdfPath,
        payload.correlationId,
      ),
    );
  }

  @EventPattern(EVENTS.INVOICE_PDF_FAILED)
  async onPdfFailed(
    @Payload() payload: InvoicePdfFailedPayload,
  ): Promise<void> {
    this.logger.warn(
      `PDF generation exhausted retries for invoice ${payload.invoiceId}: ` +
        `${payload.reason} (correlationId=${payload.correlationId})`,
    );

    // The compensating action. The invoice is not deleted — it is a financial
    // record from the moment it exists; it moves to a recoverable state.
    await this.commandBus.execute(
      new MarkGenerationFailedCommand(
        payload.tenantId,
        payload.invoiceId,
        payload.reason,
        payload.correlationId,
      ),
    );
  }

  /**
   * Terminal log line for the trace. Nothing else acts on it today — it exists
   * so the correlation ID has a visible end point, which is exactly what the
   * Definition of Done asks to be greppable.
   */
  @EventPattern(EVENTS.INVOICE_EMAIL_SENT)
  onEmailSent(@Payload() payload: InvoiceEmailSentPayload): void {
    this.logger.log(
      `Invoice ${payload.invoiceId} emailed to ${payload.recipientEmail} ` +
        `(correlationId=${payload.correlationId})`,
    );
  }
}
