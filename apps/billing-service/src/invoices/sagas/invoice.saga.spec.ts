import { Test } from '@nestjs/testing';
import { ICommand } from '@nestjs/cqrs';
import { Observable, firstValueFrom, of, throwError, toArray } from 'rxjs';

import { WORKER_CLIENT } from '../../rpc/rpc-clients.module';
import {
  MarkGenerationFailedCommand,
  MarkInvoiceIssuedCommand,
  RetryPdfGenerationCommand,
} from '../commands/create-invoice.command';
import {
  InvoiceCreatedEvent,
  InvoiceGenerationFailedEvent,
} from '../events/invoice.events';
import { InvoiceSaga } from './invoice.saga';

/**
 * Saga transitions, with the worker mocked.
 *
 * A saga is a pure mapping from an event stream to a command stream, which
 * makes it unusually testable: feed it events, collect the commands. Nothing
 * is persisted here — the handlers do that, and they are tested separately.
 */
describe('InvoiceSaga', () => {
  let saga: InvoiceSaga;
  let worker: { send: jest.Mock };

  beforeEach(async () => {
    worker = { send: jest.fn(() => of({ pdfUrl: '/invoices/invoice-1.pdf' })) };

    const moduleRef = await Test.createTestingModule({
      providers: [InvoiceSaga, { provide: WORKER_CLIENT, useValue: worker }],
    }).compile();

    saga = moduleRef.get(InvoiceSaga);
  });

  const created = new InvoiceCreatedEvent(
    'tenant-1',
    'invoice-1',
    'milestone-1',
    '1200.00',
    'EUR',
    'corr-1',
  );

  /**
   * Runs one saga branch over a single event and collects the commands it
   * emits. `toArray()` waits for the stream to complete, so a branch that
   * emits nothing yields `[]` rather than hanging.
   */
  type SagaBranch = (events$: Observable<unknown>) => Observable<ICommand>;

  function commandsFrom(
    branch: SagaBranch,
    event: unknown,
  ): Promise<ICommand[]> {
    return firstValueFrom(branch(of(event)).pipe(toArray()));
  }

  describe('on InvoiceCreatedEvent', () => {
    it('requests a PDF and issues the invoice when it succeeds', async () => {
      const commands = await commandsFrom(saga.invoiceCreated, created);

      expect(worker.send).toHaveBeenCalledTimes(1);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toBeInstanceOf(MarkInvoiceIssuedCommand);
      expect((commands[0] as MarkInvoiceIssuedCommand).pdfUrl).toBe(
        '/invoices/invoice-1.pdf',
      );
    });

    it('compensates rather than throwing when generation fails', async () => {
      worker.send.mockReturnValue(
        throwError(() => new Error('PDF renderer unavailable')),
      );

      const commands = await commandsFrom(saga.invoiceCreated, created);

      // The invoice is NOT deleted. It is a financial record from the moment
      // it exists; compensation means moving it to a recoverable state.
      expect(commands).toHaveLength(1);
      expect(commands[0]).toBeInstanceOf(MarkGenerationFailedCommand);
      expect((commands[0] as MarkGenerationFailedCommand).reason).toContain(
        'PDF renderer unavailable',
      );
    });

    it('carries the correlation ID into the command it emits', async () => {
      const commands = await commandsFrom(saga.invoiceCreated, created);

      expect((commands[0] as MarkInvoiceIssuedCommand).correlationId).toBe(
        'corr-1',
      );
    });
  });

  describe('on InvoiceGenerationFailedEvent', () => {
    const failedAfter = (attempts: number) =>
      new InvoiceGenerationFailedEvent(
        'tenant-1',
        'invoice-1',
        'PDF renderer unavailable',
        attempts,
        'corr-1',
      );

    it('queues a retry while attempts remain', async () => {
      const commands = await commandsFrom(
        saga.generationFailed,
        failedAfter(1),
      );

      expect(commands).toHaveLength(1);
      expect(commands[0]).toBeInstanceOf(RetryPdfGenerationCommand);
    });

    it('still retries on the second failure', async () => {
      const commands = await commandsFrom(
        saga.generationFailed,
        failedAfter(2),
      );

      expect(commands).toHaveLength(1);
      expect(commands[0]).toBeInstanceOf(RetryPdfGenerationCommand);
    });

    it('gives up at the attempt cap instead of retrying forever', async () => {
      const commands = await commandsFrom(
        saga.generationFailed,
        failedAfter(3),
      );

      // An unbounded retry against a deterministic failure is an infinite
      // loop that looks like activity. The invoice stays in
      // GENERATION_FAILED, which is queryable and actionable.
      expect(commands).toHaveLength(0);
    });

    it('does not retry past the cap either', async () => {
      const commands = await commandsFrom(
        saga.generationFailed,
        failedAfter(7),
      );

      expect(commands).toHaveLength(0);
    });
  });
});
