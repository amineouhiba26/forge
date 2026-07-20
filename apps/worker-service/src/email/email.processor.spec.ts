import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';

import { JOB_RETRY_POLICY, QUEUES } from '@forge/contracts';
import type { SendInvoiceEmailJobData } from '@forge/contracts';

import { DeadLetterService } from '../queue/dead-letter.service';
import { JobIdempotencyService } from '../queue/job-idempotency.service';
import { BILLING_CLIENT } from '../rpc/rpc-clients.module';
import { EmailProcessor, emailJobKey } from './email.processor';
import { MailService } from './mail.service';

describe('EmailProcessor', () => {
  let processor: EmailProcessor;
  let mail: { sendInvoice: jest.Mock };
  let idempotency: {
    claim: jest.Mock;
    complete: jest.Mock;
    release: jest.Mock;
  };
  let deadLetter: { record: jest.Mock };
  let billing: { emit: jest.Mock };

  const jobData: SendInvoiceEmailJobData = {
    invoiceId: 'invoice-1',
    tenantId: 'tenant-1',
    correlationId: 'corr-1',
    recipientEmail: 'pay@wayne.test',
    recipientName: 'Wayne Enterprises',
    pdfPath: '/storage/invoices/tenant-1/invoice-1.pdf',
    invoiceTotal: '1200.00',
    currency: 'EUR',
  };

  const makeJob = (attemptsMade = 0) =>
    ({
      data: jobData,
      attemptsMade,
      id: 'job-1',
      name: 'send-invoice-email',
    }) as unknown as Job<SendInvoiceEmailJobData>;

  beforeEach(async () => {
    mail = { sendInvoice: jest.fn().mockResolvedValue(undefined) };
    idempotency = {
      claim: jest.fn().mockResolvedValue({ proceed: true }),
      complete: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    deadLetter = { record: jest.fn().mockResolvedValue(undefined) };
    billing = { emit: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EmailProcessor,
        { provide: MailService, useValue: mail },
        { provide: JobIdempotencyService, useValue: idempotency },
        { provide: DeadLetterService, useValue: deadLetter },
        { provide: BILLING_CLIENT, useValue: billing },
      ],
    }).compile();

    processor = moduleRef.get(EmailProcessor);
  });

  describe('the job key', () => {
    it('is derived from the invoice, not the job id', () => {
      // A retry gets a fresh attempt but must produce the same key, or the
      // dedupe check never matches and every retry sends another email.
      expect(emailJobKey('invoice-1')).toBe('email:invoice-issued:invoice-1');
      expect(emailJobKey('invoice-1')).toBe(emailJobKey('invoice-1'));
    });
  });

  describe('sending', () => {
    it('sends the invoice with its PDF attached', async () => {
      await processor.process(makeJob());

      expect(mail.sendInvoice).toHaveBeenCalledTimes(1);
      const [email] = mail.sendInvoice.mock.calls[0] as [
        { to: string; pdfPath: string },
      ];
      expect(email.to).toBe('pay@wayne.test');
      expect(email.pdfPath).toBe('/storage/invoices/tenant-1/invoice-1.pdf');
    });

    it('marks the job complete only after the send returns', async () => {
      const order: string[] = [];
      mail.sendInvoice.mockImplementation(() => {
        order.push('sent');
        return Promise.resolve();
      });
      idempotency.complete.mockImplementation(() => {
        order.push('completed');
        return Promise.resolve();
      });

      await processor.process(makeJob());

      // Recording first would mean a crash in between loses the email
      // silently; this ordering risks a duplicate instead, which is the right
      // side of the trade for an invoice.
      expect(order).toEqual(['sent', 'completed']);
    });

    it('announces the send so the trace has an end point', async () => {
      await processor.process(makeJob());

      expect(billing.emit).toHaveBeenCalledTimes(1);
      const [, payload] = billing.emit.mock.calls[0] as [
        string,
        { correlationId: string },
      ];
      expect(payload.correlationId).toBe('corr-1');
    });
  });

  describe('idempotency', () => {
    it('does not send when the work already completed', async () => {
      idempotency.claim.mockResolvedValue({
        proceed: false,
        reason: 'already-completed',
      });

      const result = await processor.process(makeJob());

      expect(mail.sendInvoice).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: false });
    });

    it('reports success when skipping, so the queue does not retry', async () => {
      // The desired state already holds. Failing here would make BullMQ retry
      // a job whose effect is already in place.
      idempotency.claim.mockResolvedValue({
        proceed: false,
        reason: 'in-progress',
      });

      await expect(processor.process(makeJob())).resolves.toEqual({
        sent: false,
      });
    });

    it('releases the claim when sending fails', async () => {
      mail.sendInvoice.mockRejectedValue(new Error('SMTP unavailable'));

      await expect(processor.process(makeJob())).rejects.toThrow(
        'SMTP unavailable',
      );

      // Otherwise the first failure deadlocks every subsequent attempt against
      // its own abandoned claim.
      expect(idempotency.release).toHaveBeenCalledWith(
        emailJobKey('invoice-1'),
      );
      expect(idempotency.complete).not.toHaveBeenCalled();
    });
  });

  describe('retry and dead-lettering', () => {
    it('does not dead-letter while attempts remain', async () => {
      await processor.onFailed(makeJob(2), new Error('SMTP unavailable'));

      expect(deadLetter.record).not.toHaveBeenCalled();
    });

    it('dead-letters once retries are exhausted', async () => {
      const job = makeJob(JOB_RETRY_POLICY.attempts);

      await processor.onFailed(job, new Error('SMTP unavailable'));

      expect(deadLetter.record).toHaveBeenCalledWith(
        QUEUES.EMAIL,
        job,
        expect.any(Error),
      );
    });
  });

  describe('the retry policy itself', () => {
    it('backs off exponentially rather than at a fixed interval', () => {
      // A fixed interval hammers an SMTP server that is failing *because* it
      // is overloaded. Doubling gives it room: 2s, 4s, 8s, 16s.
      expect(JOB_RETRY_POLICY.backoff.type).toBe('exponential');
      expect(JOB_RETRY_POLICY.backoff.delay).toBe(2000);

      const delays = [1, 2, 3, 4].map(
        (attempt) => JOB_RETRY_POLICY.backoff.delay * 2 ** (attempt - 1),
      );
      expect(delays).toEqual([2000, 4000, 8000, 16000]);
    });

    it('keeps failed jobs rather than trimming them away', () => {
      // The dead-letter row is the durable record, but the Redis copy is what
      // makes a replay possible while it lasts.
      expect(JOB_RETRY_POLICY.removeOnFail).toBe(false);
    });
  });
});
