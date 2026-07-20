import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ICommand, Saga, ofType } from '@nestjs/cqrs';
import { Queue } from 'bullmq';
import { EMPTY, Observable, mergeMap } from 'rxjs';

import { JOBS, JOB_RETRY_POLICY, QUEUES } from '@forge/contracts';
import type {
  GenerateInvoicePdfJobData,
  SendInvoiceEmailJobData,
} from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

import {
  InvoiceCreatedEvent,
  InvoiceIssuedEvent,
} from '../events/invoice.events';

/**
 * The invoice saga.
 *
 * Sprint 3 built this around a synchronous RPC to worker-service, and said the
 * coupling was acceptable only until a durable queue existed. That queue is
 * here, so this is the promised rework:
 *
 * |            | Sprint 3 (RPC)                    | Sprint 5 (queue)              |
 * | ---------- | --------------------------------- | ----------------------------- |
 * | Dispatch   | blocking send, the saga waits     | `queue.add`, returns at once  |
 * | Worker down| compensate to GENERATION_FAILED   | the job waits for a worker    |
 * | Retries    | in-process, lost on crash         | in Redis, survive a restart   |
 * | Outcome    | the RPC's return value            | an event from the worker      |
 *
 * The saga no longer learns the outcome from a return value, because there is
 * no longer a call to return one. The worker announces it and billing's
 * `@EventPattern` handlers apply it — which is what makes a billing restart
 * mid-render harmless rather than a stranded invoice.
 */
@Injectable()
export class InvoiceSaga {
  private readonly logger = new Logger(InvoiceSaga.name);

  constructor(
    @InjectQueue(QUEUES.PDF) private readonly pdfQueue: Queue,
    @InjectQueue(QUEUES.EMAIL) private readonly emailQueue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  /** InvoiceCreatedEvent → enqueue a PDF render. */
  @Saga()
  invoiceCreated = (events$: Observable<unknown>): Observable<ICommand> =>
    events$.pipe(
      ofType(InvoiceCreatedEvent),
      mergeMap(async (event) => {
        const data: GenerateInvoicePdfJobData = {
          invoiceId: event.invoiceId,
          tenantId: event.tenantId,
          correlationId: event.correlationId,
        };

        await this.pdfQueue.add(JOBS.GENERATE_INVOICE_PDF, data, {
          ...JOB_RETRY_POLICY,
          // Deterministic id, so a re-published event cannot enqueue a second
          // render — BullMQ rejects a duplicate id while it still knows the job.
          //
          // Hyphen, not colon: BullMQ uses `:` as its own Redis key separator
          // and rejects custom ids containing one ("Custom Id cannot contain :").
          jobId: `pdf-${event.invoiceId}`,
        });

        this.logger.log(
          `Queued PDF generation for invoice ${event.invoiceId} ` +
            `(correlationId=${event.correlationId})`,
        );
      }),
      // Emits no command: the outcome arrives later as an event from the
      // worker, not as something this branch could return.
      mergeMap(() => EMPTY),
    );

  /** InvoiceIssuedEvent → enqueue the client email with the PDF attached. */
  @Saga()
  invoiceIssued = (events$: Observable<unknown>): Observable<ICommand> =>
    events$.pipe(
      ofType(InvoiceIssuedEvent),
      mergeMap(async (event) => {
        // The recipient is resolved here rather than carried on the event. An
        // event records what happened; a client's email address is current
        // state, and may have changed since the invoice was issued.
        const invoice = await this.prisma.forTenant(event.tenantId, (tx) =>
          tx.invoice.findUnique({ where: { id: event.invoiceId } }),
        );

        if (!invoice) {
          this.logger.error(
            `Cannot queue email: invoice ${event.invoiceId} not found ` +
              `(correlationId=${event.correlationId})`,
          );
          return;
        }

        const client = await this.prisma.forTenant(event.tenantId, (tx) =>
          tx.client.findUnique({ where: { id: invoice.clientId } }),
        );

        if (!client) {
          this.logger.error(
            `Cannot queue email: client ${invoice.clientId} not found ` +
              `(correlationId=${event.correlationId})`,
          );
          return;
        }

        const data: SendInvoiceEmailJobData = {
          invoiceId: event.invoiceId,
          tenantId: event.tenantId,
          correlationId: event.correlationId,
          recipientEmail: client.email,
          recipientName: client.name,
          pdfPath: event.pdfUrl,
          invoiceTotal: invoice.total.toFixed(2),
          currency: invoice.currency,
        };

        await this.emailQueue.add(JOBS.SEND_INVOICE_EMAIL, data, {
          ...JOB_RETRY_POLICY,
          jobId: `email-${event.invoiceId}`,
        });

        this.logger.log(
          `Queued invoice email for ${event.invoiceId} to ${client.email} ` +
            `(correlationId=${event.correlationId})`,
        );
      }),
      mergeMap(() => EMPTY),
    );
}
