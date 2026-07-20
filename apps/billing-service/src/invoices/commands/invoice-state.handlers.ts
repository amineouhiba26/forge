import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { ClientProxy } from '@nestjs/microservices';

import { WORKER_PATTERNS } from '@forge/contracts';
import type { GeneratePdfResult } from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

import { WORKER_CLIENT } from '../../rpc/rpc-clients.module';
import { rpcSend } from '../../rpc/rpc-send';
import {
  InvoiceGenerationFailedEvent,
  InvoiceIssuedEvent,
} from '../events/invoice.events';
import {
  MarkGenerationFailedCommand,
  MarkInvoiceIssuedCommand,
  RetryPdfGenerationCommand,
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

/**
 * Re-attempts the render for an invoice sitting in GENERATION_FAILED.
 *
 * In-process today. Sprint 5 moves this onto a BullMQ queue with exponential
 * backoff, at which point a crash mid-retry stops losing the attempt. The
 * invoice is never lost either way — it stays in GENERATION_FAILED until a
 * render succeeds.
 */
@CommandHandler(RetryPdfGenerationCommand)
export class RetryPdfGenerationHandler implements ICommandHandler<RetryPdfGenerationCommand> {
  private readonly logger = new Logger(RetryPdfGenerationHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
    @Inject(WORKER_CLIENT) private readonly worker: ClientProxy,
  ) {}

  async execute(command: RetryPdfGenerationCommand): Promise<void> {
    const { tenantId, invoiceId, correlationId } = command;

    try {
      const result = await rpcSend<GeneratePdfResult>(
        this.worker,
        WORKER_PATTERNS.GENERATE_INVOICE_PDF,
        { tenantId, invoiceId, correlationId },
      );

      await this.prisma.forTenant(tenantId, (tx) =>
        tx.invoice.update({
          where: { id: invoiceId },
          data: {
            status: 'ISSUED',
            pdfUrl: result.pdfUrl,
            issuedAt: new Date(),
            failureReason: null,
          },
        }),
      );

      this.logger.log(
        `Invoice ${invoiceId} ISSUED on retry (correlationId=${correlationId})`,
      );

      this.eventBus.publish(
        new InvoiceIssuedEvent(
          tenantId,
          invoiceId,
          result.pdfUrl,
          correlationId,
        ),
      );
    } catch (error) {
      const reason = (error as Error).message ?? 'PDF generation failed';

      const invoice = await this.prisma.forTenant(tenantId, (tx) =>
        tx.invoice.update({
          where: { id: invoiceId },
          data: {
            status: 'GENERATION_FAILED',
            failureReason: reason,
            generationAttempts: { increment: 1 },
          },
        }),
      );

      // Re-published so the saga re-evaluates the attempt cap. This is the
      // loop's exit condition: each failure increments the count, and the
      // saga stops emitting retries once it reaches the maximum.
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
}
