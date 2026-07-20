import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Observable, firstValueFrom, of, toArray } from 'rxjs';

import { JOBS, QUEUES } from '@forge/contracts';
import { PrismaService, TenantScopedClient } from '@forge/prisma';

import {
  InvoiceCreatedEvent,
  InvoiceIssuedEvent,
} from '../events/invoice.events';
import { InvoiceSaga } from './invoice.saga';

/**
 * Saga transitions after the Sprint 5 rework.
 *
 * What changed from Sprint 3: the saga emits no commands at all now. It
 * enqueues durable work, and the outcome comes back later as an event — so
 * these assertions are about *what was queued*, not what was returned.
 */
describe('InvoiceSaga', () => {
  let saga: InvoiceSaga;
  let pdfQueue: { add: jest.Mock };
  let emailQueue: { add: jest.Mock };
  let prisma: { forTenant: jest.Mock };

  const invoiceRow = {
    id: 'invoice-1',
    clientId: 'client-1',
    total: { toFixed: () => '1200.00' },
    currency: 'EUR',
  };
  const clientRow = {
    id: 'client-1',
    email: 'pay@wayne.test',
    name: 'Wayne Enterprises',
  };

  function stubTx(invoice: unknown, client: unknown) {
    return (_tenantId: string, fn: (tx: TenantScopedClient) => unknown) =>
      fn({
        invoice: { findUnique: () => Promise.resolve(invoice) },
        client: { findUnique: () => Promise.resolve(client) },
      } as unknown as TenantScopedClient);
  }

  beforeEach(async () => {
    pdfQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    emailQueue = { add: jest.fn().mockResolvedValue({ id: 'job-2' }) };
    prisma = { forTenant: jest.fn(stubTx(invoiceRow, clientRow)) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvoiceSaga,
        { provide: getQueueToken(QUEUES.PDF), useValue: pdfQueue },
        { provide: getQueueToken(QUEUES.EMAIL), useValue: emailQueue },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    saga = moduleRef.get(InvoiceSaga);
  });

  type SagaBranch = (events$: Observable<unknown>) => Observable<unknown>;

  /** Runs one branch over a single event and waits for it to complete. */
  function runBranch(branch: SagaBranch, event: unknown): Promise<unknown[]> {
    return firstValueFrom(branch(of(event)).pipe(toArray()));
  }

  const created = new InvoiceCreatedEvent(
    'tenant-1',
    'invoice-1',
    'milestone-1',
    '1200.00',
    'EUR',
    'corr-1',
  );

  const issued = new InvoiceIssuedEvent(
    'tenant-1',
    'invoice-1',
    '/storage/invoices/tenant-1/invoice-1.pdf',
    'corr-1',
  );

  describe('on InvoiceCreatedEvent', () => {
    it('queues a PDF job rather than calling the worker directly', async () => {
      await runBranch(saga.invoiceCreated, created);

      expect(pdfQueue.add).toHaveBeenCalledTimes(1);
      const [jobName, data] = pdfQueue.add.mock.calls[0] as [
        string,
        { invoiceId: string; tenantId: string },
      ];

      expect(jobName).toBe(JOBS.GENERATE_INVOICE_PDF);
      expect(data.invoiceId).toBe('invoice-1');
      expect(data.tenantId).toBe('tenant-1');
    });

    it('carries the correlation ID into the job payload', async () => {
      await runBranch(saga.invoiceCreated, created);

      const [, data] = pdfQueue.add.mock.calls[0] as [
        string,
        { correlationId: string },
      ];

      // This is what lets the trace survive the queue boundary — the worker
      // logs the same ID on the other side, possibly minutes later.
      expect(data.correlationId).toBe('corr-1');
    });

    it('uses a deterministic job id so a re-published event cannot double-queue', async () => {
      await runBranch(saga.invoiceCreated, created);

      const [, , options] = pdfQueue.add.mock.calls[0] as [
        string,
        unknown,
        { jobId: string },
      ];

      expect(options.jobId).toBe('pdf-invoice-1');
    });

    it('applies the shared retry policy with exponential backoff', async () => {
      await runBranch(saga.invoiceCreated, created);

      const [, , options] = pdfQueue.add.mock.calls[0] as [
        string,
        unknown,
        { attempts: number; backoff: { type: string; delay: number } },
      ];

      expect(options.attempts).toBe(5);
      // Fixed-interval retries hammer a service that is failing *because* it
      // is overloaded; doubling gives it room to recover.
      expect(options.backoff.type).toBe('exponential');
      expect(options.backoff.delay).toBe(2000);
    });

    it('emits no commands — the outcome arrives later as an event', async () => {
      const emitted = await runBranch(saga.invoiceCreated, created);

      expect(emitted).toHaveLength(0);
    });
  });

  describe('on InvoiceIssuedEvent', () => {
    it('queues the email with the recipient resolved at send time', async () => {
      await runBranch(saga.invoiceIssued, issued);

      expect(emailQueue.add).toHaveBeenCalledTimes(1);
      const [jobName, data] = emailQueue.add.mock.calls[0] as [
        string,
        { recipientEmail: string; pdfPath: string; invoiceTotal: string },
      ];

      expect(jobName).toBe(JOBS.SEND_INVOICE_EMAIL);
      // Read from the client record rather than carried on the event: an event
      // records what happened, while an address is current state.
      expect(data.recipientEmail).toBe('pay@wayne.test');
      expect(data.pdfPath).toBe('/storage/invoices/tenant-1/invoice-1.pdf');
      expect(data.invoiceTotal).toBe('1200.00');
    });

    it('does not queue an email when the invoice has vanished', async () => {
      prisma.forTenant.mockImplementation(stubTx(null, null));

      await runBranch(saga.invoiceIssued, issued);

      expect(emailQueue.add).not.toHaveBeenCalled();
    });
  });
});
