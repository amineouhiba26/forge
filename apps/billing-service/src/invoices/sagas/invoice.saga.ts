import { Inject, Injectable, Logger } from '@nestjs/common';
import { ICommand, Saga, ofType } from '@nestjs/cqrs';
import { ClientProxy } from '@nestjs/microservices';
import { EMPTY, Observable, catchError, map, mergeMap, of } from 'rxjs';

import { WORKER_PATTERNS } from '@forge/contracts';
import type { GeneratePdfResult } from '@forge/contracts';

import { WORKER_CLIENT } from '../../rpc/rpc-clients.module';
import { rpcSend } from '../../rpc/rpc-send';
import {
  MarkGenerationFailedCommand,
  MarkInvoiceIssuedCommand,
  RetryPdfGenerationCommand,
} from '../commands/create-invoice.command';
import {
  InvoiceCreatedEvent,
  InvoiceGenerationFailedEvent,
} from '../events/invoice.events';

/** Beyond this, retrying is not going to help. */
const MAX_GENERATION_ATTEMPTS = 3;

/**
 * The invoice saga: what happens *after* an invoice exists.
 *
 * A saga maps a stream of events onto a stream of commands. It owns the
 * process — "an invoice was created, so get a PDF rendered, and if that fails
 * put the invoice somewhere recoverable" — while owning no state itself.
 *
 * Why this is not one `createInvoice()` method:
 *
 * - The command handler's transaction commits before any of this runs. A
 *   single method would either hold a database transaction open across a
 *   network call to another service, or lie about atomicity.
 * - PDF generation is allowed to fail without unmaking the invoice. The
 *   invoice is a real financial record the moment it is created; a failed
 *   render is a recoverable operational problem, not a reason to pretend the
 *   invoice never happened. Only a compensating action expresses that — a
 *   rollback would be wrong.
 * - Adding a step (notify the client, post to a ledger) means adding a
 *   subscriber, not editing a method that already does four things.
 */
@Injectable()
export class InvoiceSaga {
  private readonly logger = new Logger(InvoiceSaga.name);

  constructor(@Inject(WORKER_CLIENT) private readonly worker: ClientProxy) {}

  /**
   * InvoiceCreatedEvent → request a PDF → issue it, or compensate.
   *
   * The PDF request is an **RPC, not an emitted event**, and that choice is the
   * one worth defending. An event is fire-and-forget: the saga would learn
   * nothing about the outcome, so the compensating path would need the worker
   * to publish its own failure event back — more moving parts, and a lost
   * message would leave the invoice PENDING forever with nothing watching it.
   * With a request/response call the saga observes success or failure directly
   * and can always drive the invoice out of PENDING.
   *
   * The cost is that the saga waits on the worker, and a worker outage becomes
   * a compensation rather than a queued retry. That is the right trade while
   * there is no durable queue; Sprint 5 introduces BullMQ, at which point this
   * becomes an enqueue plus completion/failure events.
   */
  @Saga()
  invoiceCreated = (events$: Observable<unknown>): Observable<ICommand> =>
    events$.pipe(
      ofType(InvoiceCreatedEvent),
      mergeMap((event) =>
        this.requestPdf(event.tenantId, event.invoiceId, event.correlationId),
      ),
    );

  /**
   * InvoiceGenerationFailedEvent → queue a retry, until the attempt cap.
   *
   * Bounded on purpose. An unbounded retry against a deterministic failure —
   * malformed data, a bug in the template — is an infinite loop that looks
   * like activity. Past the cap the invoice stays in GENERATION_FAILED with
   * its reason recorded, which is a state a human can find and act on.
   */
  @Saga()
  generationFailed = (events$: Observable<unknown>): Observable<ICommand> =>
    events$.pipe(
      ofType(InvoiceGenerationFailedEvent),
      mergeMap((event) => {
        if (event.attempts >= MAX_GENERATION_ATTEMPTS) {
          this.logger.warn(
            `Invoice ${event.invoiceId} has failed generation ${event.attempts} times — ` +
              `giving up, left in GENERATION_FAILED for manual inspection ` +
              `(correlationId=${event.correlationId})`,
          );

          // EMPTY completes without emitting, ending this branch of the saga.
          // The invoice is not lost — it is parked in a queryable failed state.
          return EMPTY;
        }

        this.logger.log(
          `Queueing PDF retry ${event.attempts + 1}/${MAX_GENERATION_ATTEMPTS} for ` +
            `invoice ${event.invoiceId} (correlationId=${event.correlationId})`,
        );

        return of(
          new RetryPdfGenerationCommand(
            event.tenantId,
            event.invoiceId,
            event.correlationId,
          ),
        );
      }),
    );

  /** Shared by the initial attempt and by retries. */
  private requestPdf(
    tenantId: string,
    invoiceId: string,
    correlationId: string,
  ): Observable<ICommand> {
    return of(null).pipe(
      mergeMap(() =>
        rpcSend<GeneratePdfResult>(
          this.worker,
          WORKER_PATTERNS.GENERATE_INVOICE_PDF,
          { tenantId, invoiceId, correlationId },
        ),
      ),
      map(
        (result) =>
          new MarkInvoiceIssuedCommand(
            tenantId,
            invoiceId,
            result.pdfUrl,
            correlationId,
          ) as ICommand,
      ),
      catchError((error: Error) => {
        this.logger.error(
          `PDF generation failed for invoice ${invoiceId}: ${error.message} ` +
            `(correlationId=${correlationId})`,
        );

        // The compensating action. Not a rollback: the invoice stays, and is
        // moved to a state that says exactly what went wrong.
        return of(
          new MarkGenerationFailedCommand(
            tenantId,
            invoiceId,
            error.message ?? 'PDF generation failed',
            correlationId,
          ) as ICommand,
        );
      }),
    );
  }
}
