import { Logger } from '@nestjs/common';
import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';

import { PrismaService } from '@forge/prisma';

import {
  InvoiceGenerationFailedEvent,
  InvoiceIssuedEvent,
} from '../events/invoice.events';
import {
  MarkGenerationFailedCommand,
  MarkInvoiceIssuedCommand,
} from './create-invoice.command';

@CommandHandler(MarkInvoiceIssuedCommand)
export class MarkInvoiceIssuedHandler implements ICommandHandler<MarkInvoiceIssuedCommand> {
  private readonly logger = new Logger(MarkInvoiceIssuedHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: MarkInvoiceIssuedCommand): Promise<void> {
    const { tenantId, invoiceId, pdfUrl, correlationId } = command;

    await this.prisma.forTenant(tenantId, (tx) =>
      tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: 'ISSUED',
          pdfUrl,
          issuedAt: new Date(),
          // Cleared on success: a stale reason on an issued invoice would
          // read as an unresolved problem during an incident.
          failureReason: null,
        },
      }),
    );

    this.logger.log(
      `Invoice ${invoiceId} ISSUED (correlationId=${correlationId})`,
    );

    this.eventBus.publish(
      new InvoiceIssuedEvent(tenantId, invoiceId, pdfUrl, correlationId),
    );
  }
}

/**
 * The compensating action.
 *
 * Note what it does *not* do: delete the invoice. The invoice is a financial
 * record from the moment it is created, and a failed PDF render is an
 * operational problem, not grounds to pretend the billing event never
 * happened. Compensation here means moving to a recoverable, queryable state —
 * which is exactly the difference between a saga and a database transaction.
 */
@CommandHandler(MarkGenerationFailedCommand)
export class MarkGenerationFailedHandler implements ICommandHandler<MarkGenerationFailedCommand> {
  private readonly logger = new Logger(MarkGenerationFailedHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: MarkGenerationFailedCommand): Promise<void> {
    const { tenantId, invoiceId, reason, correlationId } = command;

    const invoice = await this.prisma.forTenant(tenantId, (tx) =>
      tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: 'GENERATION_FAILED',
          failureReason: reason,
          // Incremented in the database rather than computed in memory, so
          // concurrent attempts cannot both read the same count and write the
          // same value — which would let retries run forever.
          generationAttempts: { increment: 1 },
        },
      }),
    );

    this.logger.warn(
      `Invoice ${invoiceId} moved to GENERATION_FAILED after ` +
        `${invoice.generationAttempts} attempt(s): ${reason} ` +
        `(correlationId=${correlationId})`,
    );

    // Published so the saga can decide whether to retry. The handler does not
    // decide that itself — persisting state and orchestrating the process are
    // different jobs, and keeping them apart is what makes each testable.
    this.eventBus.publish(
      new InvoiceGenerationFailedEvent(
        tenantId,
        invoiceId,
        reason,
        invoice.generationAttempts,
        correlationId,
      ),
    );
  }
}
