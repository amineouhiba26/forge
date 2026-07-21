import 'dotenv/config';

import { access } from 'node:fs/promises';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { InvoiceStatusDto, buildRedisTransportOptions } from '@forge/contracts';
import type {
  AuthResultDto,
  ClientDto,
  ContractDto,
  InvoiceDto,
} from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

import { AppModule as BillingModule } from '../apps/billing-service/src/app.module';
import { AppModule as ContractsModule } from '../apps/contracts-service/src/app.module';
import { AppModule as GatewayModule } from '../apps/gateway/src/app.module';
import { AppModule as TenantsModule } from '../apps/tenants-service/src/app.module';
import { AppModule as WorkerModule } from '../apps/worker-service/src/app.module';
import { MailService } from '../apps/worker-service/src/email/mail.service';
import { PdfRendererService } from '../apps/worker-service/src/pdf/pdf-renderer.service';

function body<T>(response: { body: unknown }): T {
  return response.body as T;
}

let app: INestApplication;

function server() {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

/**
 * Sprint 5: the full asynchronous chain.
 *
 * Real Redis and real BullMQ — the queue is the thing under test, so an
 * in-memory stand-in would prove nothing about durability or retries. SMTP is
 * the one seam that is replaced: sending to Mailpit works locally but adds a
 * container CI would have to run just to assert "an email was attempted".
 */
describe('Async worker chain (e2e)', () => {
  const services: Awaited<ReturnType<typeof NestFactory.createMicroservice>>[] =
    [];
  let prisma: PrismaService;

  const run = Date.now();
  let tenant: { tenantId: string; token: string };
  let clientId: string;

  /** Every email the worker attempted, and whether it was allowed to succeed. */
  const sentEmails: { to: string; invoiceId: string; pdfPath: string }[] = [];
  let failSmtp = false;
  let failPdf = false;

  beforeAll(async () => {
    for (const module of [TenantsModule, ContractsModule, BillingModule]) {
      const service = await NestFactory.createMicroservice<MicroserviceOptions>(
        module,
        { ...buildRedisTransportOptions(), logger: false },
      );
      await service.listen();
      services.push(service);
    }

    // The real renderer, wrapped so a failure can be forced. Sprint 3 did this
    // with an env flag read inside the worker; scoping it to the instance
    // avoids the process-global state that made that suite flaky.
    const realRenderer = new PdfRendererService({
      getOrThrow: (key: string) => process.env[key],
    } as never);

    const workerRef = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(PdfRendererService)
      .useValue({
        renderInvoice: (tenantId: string, input: { invoiceId: string }) => {
          if (failPdf) {
            return Promise.reject(new Error('PDF renderer unavailable'));
          }
          return realRenderer.renderInvoice(tenantId, input as never);
        },
      })
      .overrideProvider(MailService)
      .useValue({
        sendInvoice: (email: {
          to: string;
          invoiceId: string;
          pdfPath: string;
        }) => {
          if (failSmtp) {
            // Mirrors what nodemailer throws when nothing is listening, which
            // is the failure the retry policy exists for.
            return Promise.reject(new Error('connect ECONNREFUSED'));
          }
          sentEmails.push(email);
          return Promise.resolve();
        },
      })
      .compile();

    const worker = workerRef.createNestMicroservice<MicroserviceOptions>({
      ...buildRedisTransportOptions(),
      logger: false,
    });
    await worker.listen();
    services.push(worker);

    const moduleRef = await Test.createTestingModule({
      imports: [GatewayModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = services[0].get(PrismaService, { strict: false });

    tenant = await signup(`worker-${run}@acme.test`, `Worker ${run}`);
    clientId = await createClient(tenant.token, `client-${run}@wayne.test`);
  });

  afterAll(async () => {
    await app?.close();
    for (const service of services) await service.close();
  });

  async function signup(email: string, name: string) {
    const response = await request(server())
      .post('/auth/signup')
      .send({
        tenant: { name, country: 'FR' },
        owner: { email, password: 'a-long-enough-password' },
      })
      .expect(201);

    const result = body<AuthResultDto>(response);
    return { tenantId: result.user.tenantId, token: result.tokens.accessToken };
  }

  async function createClient(token: string, email: string) {
    const response = await request(server())
      .post('/clients')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Wayne Enterprises', email })
      .expect(201);

    return body<ClientDto>(response).id;
  }

  /** Drives contract → milestone complete → invoice, returning both IDs. */
  async function invoiceAMilestone(
    amount: number,
  ): Promise<{ invoiceId: string; correlationId: string }> {
    const created = await request(server())
      .post('/contracts')
      .set('Authorization', `Bearer ${tenant.token}`)
      .send({
        clientId,
        title: `Contract ${Math.random()}`,
        milestones: [{ title: 'Work', amount, dueDate: '2026-09-01' }],
      })
      .expect(201);

    const contract = body<ContractDto>(created);

    await request(server())
      .patch(`/contracts/${contract.id}`)
      .set('Authorization', `Bearer ${tenant.token}`)
      .send({ status: 'ACTIVE' })
      .expect(200);

    await request(server())
      .patch(
        `/contracts/${contract.id}/milestones/${contract.milestones[0].id}/complete`,
      )
      .set('Authorization', `Bearer ${tenant.token}`)
      .expect(200);

    const response = await request(server())
      .post('/invoices')
      .set('Authorization', `Bearer ${tenant.token}`)
      .send({ milestoneId: contract.milestones[0].id })
      .expect(201);

    return {
      invoiceId: body<{ invoiceId: string }>(response).invoiceId,
      // The gateway echoes the ID it generated — the same one that will appear
      // in the worker's logs on the other side of the queue.
      correlationId: response.headers['x-correlation-id'],
    };
  }

  async function waitForInvoice(
    invoiceId: string,
    status: InvoiceStatusDto,
    timeoutMs = 20_000,
  ): Promise<InvoiceDto> {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = 'never fetched';

    for (;;) {
      const response = await request(server())
        .get(`/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${tenant.token}`);

      // Not `.expect(200)` on every attempt: a hard assert inside a poll turns
      // any single transient response into a failure with no context about
      // what the invoice was actually doing. Record it and let the deadline
      // decide, so the eventual error names the real state.
      if (response.status === 200) {
        const invoice = body<InvoiceDto>(response);
        if (invoice.status === status) return invoice;
        lastStatus = invoice.status;
      } else {
        lastStatus = `HTTP ${response.status} ${JSON.stringify(response.body)}`;
      }

      if (Date.now() > deadline) {
        throw new Error(
          `Invoice ${invoiceId} never reached ${status} (last: ${lastStatus})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!(await predicate())) {
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  describe('the happy path, end to end', () => {
    let invoiceId: string;
    let correlationId: string;

    it('renders a PDF and moves the invoice to ISSUED', async () => {
      const result = await invoiceAMilestone(1000);
      invoiceId = result.invoiceId;
      correlationId = result.correlationId;

      const invoice = await waitForInvoice(invoiceId, InvoiceStatusDto.ISSUED);

      // The queue did the work: billing enqueued, the worker rendered, and
      // billing learned the outcome from an event rather than a return value.
      expect(invoice.pdfUrl).toContain(invoiceId);
    });

    it('writes the PDF to disk where it says it did', async () => {
      const invoice = await waitForInvoice(invoiceId, InvoiceStatusDto.ISSUED);

      // A path in the database that points at nothing would satisfy every
      // other assertion here.
      await expect(access(invoice.pdfUrl as string)).resolves.toBeUndefined();
    });

    it('emails the invoice with the PDF attached', async () => {
      await waitFor(
        () => sentEmails.some((email) => email.invoiceId === invoiceId),
        'the invoice email',
      );

      const email = sentEmails.find((e) => e.invoiceId === invoiceId);
      expect(email?.to).toBe(`client-${run}@wayne.test`);
      expect(email?.pdfPath).toContain(invoiceId);
    });

    it('carries one correlation ID from the HTTP request into the queued job', async () => {
      // The Definition of Done. The ID is generated at the gateway, survives
      // the command, the event, the BullMQ payload and the worker — which is
      // what makes the whole journey greppable as one unit.
      expect(correlationId).toMatch(/^[0-9a-f-]{36}$/i);

      const dlqRows = await prisma.forTenant(tenant.tenantId, (tx) =>
        tx.deadLetterJob.findMany({ where: { correlationId } }),
      );
      // Nothing failed on the happy path.
      expect(dlqRows).toHaveLength(0);
    });
  });

  describe('job idempotency', () => {
    it('does not send a second email when the same job is reprocessed', async () => {
      const { invoiceId } = await invoiceAMilestone(750);
      await waitForInvoice(invoiceId, InvoiceStatusDto.ISSUED);
      await waitFor(
        () => sentEmails.some((email) => email.invoiceId === invoiceId),
        'the first email',
      );

      const before = sentEmails.filter(
        (email) => email.invoiceId === invoiceId,
      ).length;
      expect(before).toBe(1);

      // Simulates a worker that crashed after sending but before acking: the
      // job runs again with the same payload.
      const processedJob = await prisma.processedJob.findUnique({
        where: { jobKey: `email:invoice-issued:${invoiceId}` },
      });
      expect(processedJob?.state).toBe('COMPLETED');

      const emailQueueJob = {
        invoiceId,
        tenantId: tenant.tenantId,
        correlationId: 'replay-correlation',
        recipientEmail: `client-${run}@wayne.test`,
        recipientName: 'Wayne Enterprises',
        pdfPath: '/tmp/whatever.pdf',
        invoiceTotal: '900.00',
        currency: 'EUR',
      };

      const { Queue } = await import('bullmq');
      const queue = new Queue('email', {
        connection: {
          host: process.env.REDIS_HOST,
          port: Number(process.env.REDIS_PORT),
        },
      });
      // A fresh job id, so BullMQ treats it as new work — the dedupe has to
      // come from the application, not from the queue.
      await queue.add('send-invoice-email', emailQueueJob, {
        jobId: `email-replay-${invoiceId}`,
      });
      await queue.close();

      // Give the worker time to pick it up and skip it.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const after = sentEmails.filter(
        (email) => email.invoiceId === invoiceId,
      ).length;
      expect(after).toBe(1);
    });
  });

  describe('retry and dead-lettering', () => {
    it('retries a failing email and records a dead letter once exhausted', async () => {
      failSmtp = true;

      try {
        const { invoiceId, correlationId } = await invoiceAMilestone(500);
        await waitForInvoice(invoiceId, InvoiceStatusDto.ISSUED);

        // Five attempts with exponential backoff: 2 + 4 + 8 + 16 = 30s of
        // waiting before the last one, so the timeout has to allow for it.
        await waitFor(
          async () => {
            const rows = await prisma.forTenant(tenant.tenantId, (tx) =>
              tx.deadLetterJob.findMany({ where: { correlationId } }),
            );
            return rows.length > 0;
          },
          'the dead-letter row',
          60_000,
        );

        const [dead] = await prisma.forTenant(tenant.tenantId, (tx) =>
          tx.deadLetterJob.findMany({ where: { correlationId } }),
        );

        expect(dead.queueName).toBe('email');
        expect(dead.attempts).toBe(5);
        expect(dead.failedReason).toContain('ECONNREFUSED');
        // The payload is stored so the job can be replayed by hand after a fix.
        expect(dead.payload).toMatchObject({ invoiceId });
        // Traceable to the request that started it, which is the point of
        // carrying the ID this far.
        expect(dead.correlationId).toBe(correlationId);

        // The invoice itself is untouched: a failed email does not unmake a
        // rendered, issued invoice.
        const invoice = await waitForInvoice(
          invoiceId,
          InvoiceStatusDto.ISSUED,
        );
        expect(invoice.pdfUrl).toContain(invoiceId);
      } finally {
        failSmtp = false;
      }
    }, 90_000);
  });

  describe('the compensating path', () => {
    it('parks the invoice in GENERATION_FAILED once PDF retries are exhausted', async () => {
      failPdf = true;

      try {
        const { invoiceId, correlationId } = await invoiceAMilestone(650);

        // Five attempts with exponential backoff before it gives up.
        const invoice = await waitForInvoice(
          invoiceId,
          InvoiceStatusDto.GENERATION_FAILED,
          60_000,
        );

        // The invoice is NOT deleted. It became a financial record the moment
        // it was created; compensation moves it somewhere recoverable rather
        // than pretending the billing event never happened.
        expect(invoice.id).toBe(invoiceId);
        expect(invoice.failureReason).toContain('PDF renderer unavailable');
        expect(invoice.pdfUrl).toBeNull();

        // And the failure is recorded durably, traceable to the request.
        const [dead] = await prisma.forTenant(tenant.tenantId, (tx) =>
          tx.deadLetterJob.findMany({ where: { correlationId } }),
        );
        expect(dead.queueName).toBe('pdf');
        expect(dead.attempts).toBe(5);
      } finally {
        failPdf = false;
      }
    }, 90_000);
  });
});
