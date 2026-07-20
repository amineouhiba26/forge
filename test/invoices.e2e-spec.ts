import 'dotenv/config';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import { InvoiceStatusDto, buildRedisTransportOptions } from '@forge/contracts';
import type {
  AuthResultDto,
  ClientDto,
  ContractDto,
  InvoiceDto,
  PaginatedResult,
} from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

import { AppModule as BillingModule } from '../apps/billing-service/src/app.module';
import { AppModule as ContractsModule } from '../apps/contracts-service/src/app.module';
import { AppModule as GatewayModule } from '../apps/gateway/src/app.module';
import { AppModule as TenantsModule } from '../apps/tenants-service/src/app.module';
import { assertNoCompetingServices } from './support/no-competing-services';
import { AppModule as WorkerModule } from '../apps/worker-service/src/app.module';

function body<T>(response: { body: unknown }): T {
  return response.body as T;
}

let app: INestApplication;

function server() {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

/** The saga is asynchronous — poll rather than guess at a sleep duration. */
async function waitForStatus(
  invoiceId: string,
  token: string,
  status: InvoiceStatusDto,
  timeoutMs = 10_000,
): Promise<InvoiceDto> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const response = await request(server())
      .get(`/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const invoice = body<InvoiceDto>(response);
    if (invoice.status === status) return invoice;

    if (Date.now() > deadline) {
      throw new Error(
        `Invoice ${invoiceId} never reached ${status} (last: ${invoice.status})`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * The Sprint 3 saga end to end: a completed milestone becomes an invoice,
 * the saga renders it, and a forced failure exercises the compensating path.
 *
 * All five services run in-process against real Postgres and Redis.
 */
describe('Invoicing saga (e2e)', () => {
  const services: Awaited<ReturnType<typeof NestFactory.createMicroservice>>[] =
    [];
  let prisma: PrismaService;

  const run = Date.now();

  let fr: { tenantId: string; token: string };
  let de: { tenantId: string; token: string };
  let memberToken: string;
  let frClientId: string;

  beforeAll(async () => {
    // Fails fast and explains itself if another stack is on this Redis.
    await assertNoCompetingServices();

    for (const module of [
      TenantsModule,
      ContractsModule,
      BillingModule,
      WorkerModule,
    ]) {
      const service = await NestFactory.createMicroservice<MicroserviceOptions>(
        module,
        { ...buildRedisTransportOptions(), logger: false },
      );
      await service.listen();
      services.push(service);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [GatewayModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = services[0].get(PrismaService, { strict: false });

    fr = await signup(`billing-fr-${run}@acme.test`, `Acme FR ${run}`, 'FR');
    de = await signup(
      `billing-de-${run}@globex.test`,
      `Globex DE ${run}`,
      'DE',
    );
    memberToken = await createMember(fr.tenantId, `member-${run}@acme.test`);
    frClientId = await createClient(fr.token, `client-${run}@wayne.test`);
  });

  afterAll(async () => {
    await app?.close();
    for (const service of services) await service.close();
  });

  async function signup(email: string, name: string, country: string) {
    const response = await request(server())
      .post('/auth/signup')
      .send({
        tenant: { name, country },
        owner: { email, password: 'a-long-enough-password' },
      })
      .expect(201);

    const result = body<AuthResultDto>(response);
    return {
      tenantId: result.user.tenantId,
      token: result.tokens.accessToken,
    };
  }

  async function createMember(tenantId: string, email: string) {
    const passwordHash = await bcrypt.hash('a-long-enough-password', 4);
    await prisma.forTenant(tenantId, (tx) =>
      tx.user.create({
        data: { tenantId, email, passwordHash, role: 'MEMBER' },
      }),
    );

    const response = await request(server())
      .post('/auth/login')
      .send({ tenantId, email, password: 'a-long-enough-password' })
      .expect(200);

    return body<AuthResultDto>(response).tokens.accessToken;
  }

  async function createClient(token: string, email: string) {
    const response = await request(server())
      .post('/clients')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Wayne Enterprises', email })
      .expect(201);

    return body<ClientDto>(response).id;
  }

  /** Creates a contract and returns it, optionally activating it. */
  async function createContract(
    token: string,
    clientId: string,
    amount: number,
    activate: boolean,
  ): Promise<ContractDto> {
    const created = await request(server())
      .post('/contracts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        clientId,
        title: `Contract ${Math.random()}`,
        milestones: [{ title: 'Work', amount, dueDate: '2026-09-01' }],
      })
      .expect(201);

    const contract = body<ContractDto>(created);

    if (activate) {
      await request(server())
        .patch(`/contracts/${contract.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'ACTIVE' })
        .expect(200);
    }

    return contract;
  }

  /** Contract → active → milestone complete → ready to invoice. */
  async function completedMilestone(
    token: string,
    clientId: string,
    amount: number,
  ): Promise<string> {
    const contract = await createContract(token, clientId, amount, true);
    const milestoneId = contract.milestones[0].id;

    await request(server())
      .patch(`/contracts/${contract.id}/milestones/${milestoneId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    return milestoneId;
  }

  async function createInvoice(token: string, milestoneId: string) {
    const response = await request(server())
      .post('/invoices')
      .set('Authorization', `Bearer ${token}`)
      .send({ milestoneId })
      .expect(201);

    return body<{ invoiceId: string }>(response).invoiceId;
  }

  describe('the command refuses invalid work', () => {
    it('will not invoice a milestone that is not complete', async () => {
      const contract = await createContract(fr.token, frClientId, 1000, true);

      await request(server())
        .post('/invoices')
        .set('Authorization', `Bearer ${fr.token}`)
        .send({ milestoneId: contract.milestones[0].id })
        .expect(409);
    });

    it('will not invoice against a cancelled contract', async () => {
      const contract = await createContract(fr.token, frClientId, 1000, true);
      const milestoneId = contract.milestones[0].id;

      await request(server())
        .patch(`/contracts/${contract.id}/milestones/${milestoneId}/complete`)
        .set('Authorization', `Bearer ${fr.token}`)
        .expect(200);

      await request(server())
        .patch(`/contracts/${contract.id}`)
        .set('Authorization', `Bearer ${fr.token}`)
        .send({ status: 'CANCELLED' })
        .expect(200);

      await request(server())
        .post('/invoices')
        .set('Authorization', `Bearer ${fr.token}`)
        .send({ milestoneId })
        .expect(409);
    });

    it('rejects an unknown milestone as 404, not 500', async () => {
      await request(server())
        .post('/invoices')
        .set('Authorization', `Bearer ${fr.token}`)
        .send({ milestoneId: '11111111-1111-4111-8111-111111111111' })
        .expect(404);
    });
  });

  describe('command → event → saga → issued', () => {
    it('creates the invoice and the saga drives it to ISSUED', async () => {
      const milestoneId = await completedMilestone(fr.token, frClientId, 1000);
      const invoiceId = await createInvoice(fr.token, milestoneId);

      const invoice = await waitForStatus(
        invoiceId,
        fr.token,
        InvoiceStatusDto.ISSUED,
      );

      // The PDF URL is what proves the saga's RPC to the worker completed and
      // the result was written back by the command it emitted.
      expect(invoice.pdfUrl).toContain(invoiceId);
      expect(invoice.issuedAt).not.toBeNull();
      expect(invoice.failureReason).toBeNull();
    });

    it('applies the tax rate of the tenant country', async () => {
      const milestoneId = await completedMilestone(fr.token, frClientId, 1000);
      const invoiceId = await createInvoice(fr.token, milestoneId);
      const invoice = await waitForStatus(
        invoiceId,
        fr.token,
        InvoiceStatusDto.ISSUED,
      );

      // FR = 20%.
      expect(invoice.subtotal).toBe('1000.00');
      expect(invoice.taxRate).toBe('20.00');
      expect(invoice.taxAmount).toBe('200.00');
      expect(invoice.total).toBe('1200.00');
    });

    it('applies a different country rate for a different tenant', async () => {
      const deClientId = await createClient(de.token, `de-${run}@wayne.test`);
      const milestoneId = await completedMilestone(de.token, deClientId, 1000);
      const invoiceId = await createInvoice(de.token, milestoneId);
      const invoice = await waitForStatus(
        invoiceId,
        de.token,
        InvoiceStatusDto.ISSUED,
      );

      // DE = 19%.
      expect(invoice.taxRate).toBe('19.00');
      expect(invoice.total).toBe('1190.00');
    });

    it('will not invoice the same milestone twice', async () => {
      const milestoneId = await completedMilestone(fr.token, frClientId, 500);
      const invoiceId = await createInvoice(fr.token, milestoneId);

      // Wait for this invoice's saga to finish before asserting. Sagas run
      // asynchronously, so leaving one in flight lets it overlap the next
      // test — and the compensation tests toggle a global failure flag that
      // an in-flight saga would pick up. That overlap made this suite flaky.
      await waitForStatus(invoiceId, fr.token, InvoiceStatusDto.ISSUED);

      // The unique constraint on milestone_id is the real guard — an
      // application-level check could not survive two concurrent commands.
      await request(server())
        .post('/invoices')
        .set('Authorization', `Bearer ${fr.token}`)
        .send({ milestoneId })
        .expect(409);
    });
  });

  // The compensating path moved to test/worker.e2e-spec.ts in Sprint 5.
  // PDF generation is a BullMQ job now, not an RPC, so forcing a failure means
  // driving the queue through five attempts with exponential backoff — which
  // belongs with the other queue tests and their longer timeouts.

  describe('the query side', () => {
    it('lists invoices with pagination metadata', async () => {
      const response = await request(server())
        .get('/invoices?page=1&limit=2')
        .set('Authorization', `Bearer ${fr.token}`)
        .expect(200);

      const page = body<PaginatedResult<InvoiceDto>>(response);
      expect(page.items.length).toBeLessThanOrEqual(2);
      expect(page.total).toBeGreaterThan(0);
    });

    it('filters by status', async () => {
      const response = await request(server())
        .get('/invoices?status=ISSUED&limit=100')
        .set('Authorization', `Bearer ${fr.token}`)
        .expect(200);

      const page = body<PaginatedResult<InvoiceDto>>(response);
      expect(page.items.length).toBeGreaterThan(0);
      expect(
        page.items.every((i) => i.status === InvoiceStatusDto.ISSUED),
      ).toBe(true);
    });

    it('caps the page size', async () => {
      await request(server())
        .get('/invoices?limit=100000')
        .set('Authorization', `Bearer ${fr.token}`)
        .expect(400);
    });
  });

  describe('permissions and isolation', () => {
    it('forbids a MEMBER from issuing an invoice', async () => {
      const milestoneId = await completedMilestone(fr.token, frClientId, 100);

      // The backlog's distinction: a member sees contracts but cannot turn
      // one into money.
      await request(server())
        .post('/invoices')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ milestoneId })
        .expect(403);
    });

    it('lets a MEMBER read invoices', async () => {
      await request(server())
        .get('/invoices')
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(200);
    });

    it("hides another tenant's invoice", async () => {
      const milestoneId = await completedMilestone(fr.token, frClientId, 900);
      const invoiceId = await createInvoice(fr.token, milestoneId);

      await request(server())
        .get(`/invoices/${invoiceId}`)
        .set('Authorization', `Bearer ${de.token}`)
        .expect(404);
    });

    it("refuses to invoice another tenant's milestone", async () => {
      const milestoneId = await completedMilestone(fr.token, frClientId, 400);

      // The milestone lookup runs under the caller's tenant context, so the
      // row is invisible rather than merely refused.
      await request(server())
        .post('/invoices')
        .set('Authorization', `Bearer ${de.token}`)
        .send({ milestoneId })
        .expect(404);
    });
  });
});
