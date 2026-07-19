import 'dotenv/config';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';

import {
  ContractStatusDto,
  buildRedisTransportOptions,
} from '@forge/contracts';
import type {
  AuthResultDto,
  ClientDto,
  ContractDto,
  MilestoneDto,
  PaginatedResult,
} from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

import { AppModule as GatewayModule } from '../apps/gateway/src/app.module';
import { AppModule as ContractsModule } from '../apps/contracts-service/src/app.module';
import { AppModule as TenantsModule } from '../apps/tenants-service/src/app.module';

function body<T>(response: { body: unknown }): T {
  return response.body as T;
}

let app: INestApplication;

function server() {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

/**
 * The Sprint 2 flow end to end: client → contract with milestones → complete a
 * milestone, with permissions and tenant isolation enforced throughout.
 *
 * Requires `docker compose up` and applied migrations.
 */
describe('Clients & contracts (e2e)', () => {
  let tenantsService: Awaited<
    ReturnType<typeof NestFactory.createMicroservice>
  >;
  let contractsService: Awaited<
    ReturnType<typeof NestFactory.createMicroservice>
  >;
  let prisma: PrismaService;

  const run = Date.now();

  let owner: { tenantId: string; accessToken: string };
  let member: { accessToken: string };
  let otherTenant: { tenantId: string; accessToken: string };

  let clientId: string;
  let contractId: string;
  let milestoneId: string;

  beforeAll(async () => {
    tenantsService = await NestFactory.createMicroservice<MicroserviceOptions>(
      TenantsModule,
      { ...buildRedisTransportOptions(), logger: false },
    );
    await tenantsService.listen();

    contractsService =
      await NestFactory.createMicroservice<MicroserviceOptions>(
        ContractsModule,
        { ...buildRedisTransportOptions(), logger: false },
      );
    await contractsService.listen();

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

    prisma = contractsService.get(PrismaService, { strict: false });

    owner = await signup(`owner-${run}@acme.test`, `Acme ${run}`);
    otherTenant = await signup(`owner-${run}@globex.test`, `Globex ${run}`);
    member = await createMemberIn(owner.tenantId, `member-${run}@acme.test`);
  });

  afterAll(async () => {
    await app?.close();
    await tenantsService?.close();
    await contractsService?.close();
  });

  async function signup(email: string, tenantName: string) {
    const response = await request(server())
      .post('/auth/signup')
      .send({
        tenant: { name: tenantName, country: 'FR' },
        owner: { email, password: 'a-long-enough-password' },
      })
      .expect(201);

    const result = body<AuthResultDto>(response);
    return {
      tenantId: result.user.tenantId,
      accessToken: result.tokens.accessToken,
    };
  }

  /**
   * There is no invite endpoint yet, so the MEMBER is seeded directly and then
   * logs in through the real API. Signing a token by hand would bypass the
   * login path and prove less.
   */
  async function createMemberIn(tenantId: string, email: string) {
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

    return { accessToken: body<AuthResultDto>(response).tokens.accessToken };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  describe('the full flow', () => {
    it('creates a client', async () => {
      const response = await request(server())
        .post('/clients')
        .set(auth(owner.accessToken))
        .send({
          name: 'Wayne Enterprises',
          email: `pay-${run}@wayne.test`,
          companyName: 'Wayne Corp',
        })
        .expect(201);

      clientId = body<ClientDto>(response).id;
      expect(clientId).toBeDefined();
    });

    it('creates a contract with nested milestones in one call', async () => {
      const response = await request(server())
        .post('/contracts')
        .set(auth(owner.accessToken))
        .send({
          clientId,
          title: 'Website rebuild',
          currency: 'EUR',
          milestones: [
            { title: 'Design', amount: 2500.5, dueDate: '2026-09-01' },
            { title: 'Build', amount: 7000, dueDate: '2026-10-15' },
          ],
        })
        .expect(201);

      const contract = body<ContractDto>(response);
      contractId = contract.id;
      milestoneId = contract.milestones[0].id;

      expect(contract.status).toBe('DRAFT');
      expect(contract.milestones).toHaveLength(2);
      // Money keeps its minor units and stays a string.
      expect(contract.milestones[0].amount).toBe('2500.50');
    });

    it('refuses to complete a milestone while the contract is a draft', async () => {
      await request(server())
        .patch(`/contracts/${contractId}/milestones/${milestoneId}/complete`)
        .set(auth(owner.accessToken))
        .expect(409);
    });

    it('activates the contract', async () => {
      const response = await request(server())
        .patch(`/contracts/${contractId}`)
        .set(auth(owner.accessToken))
        .send({ status: 'ACTIVE' })
        .expect(200);

      expect(body<ContractDto>(response).status).toBe('ACTIVE');
    });

    it('marks a milestone complete', async () => {
      const response = await request(server())
        .patch(`/contracts/${contractId}/milestones/${milestoneId}/complete`)
        .set(auth(owner.accessToken))
        .expect(200);

      const milestone = body<MilestoneDto>(response);
      expect(milestone.status).toBe('COMPLETE');
      expect(milestone.completedAt).not.toBeNull();
    });

    it('refuses to complete the same milestone twice', async () => {
      await request(server())
        .patch(`/contracts/${contractId}/milestones/${milestoneId}/complete`)
        .set(auth(owner.accessToken))
        .expect(409);
    });
  });

  describe('contract status machine', () => {
    it('rejects skipping DRAFT straight to COMPLETED', async () => {
      const fresh = await createContract('Skip test');

      await request(server())
        .patch(`/contracts/${fresh}`)
        .set(auth(owner.accessToken))
        .send({ status: 'COMPLETED' })
        .expect(409);
    });

    it('treats CANCELLED as terminal', async () => {
      const fresh = await createContract('Terminal test');

      await request(server())
        .patch(`/contracts/${fresh}`)
        .set(auth(owner.accessToken))
        .send({ status: 'CANCELLED' })
        .expect(200);

      await request(server())
        .patch(`/contracts/${fresh}`)
        .set(auth(owner.accessToken))
        .send({ status: 'ACTIVE' })
        .expect(409);
    });
  });

  describe('validation', () => {
    it('rejects a contract with no milestones', async () => {
      await request(server())
        .post('/contracts')
        .set(auth(owner.accessToken))
        .send({ clientId, title: 'Empty', milestones: [] })
        .expect(400);
    });

    it('rejects a negative milestone amount, naming the exact path', async () => {
      const response = await request(server())
        .post('/contracts')
        .set(auth(owner.accessToken))
        .send({
          clientId,
          title: 'Negative',
          milestones: [{ title: 'Bad', amount: -50, dueDate: '2026-09-01' }],
        })
        .expect(400);

      // Nested validation actually descended into the array — without `@Type`
      // on the milestones field it would pass with arbitrary contents.
      const message = body<{ message: string[] }>(response).message;
      expect(message.join(' ')).toContain('milestones.0.amount');
    });

    it('rejects an unknown field rather than silently dropping it', async () => {
      await request(server())
        .post('/clients')
        .set(auth(owner.accessToken))
        .send({
          name: 'Sneaky',
          email: `sneaky-${run}@x.test`,
          isAdmin: true,
        })
        .expect(400);
    });
  });

  describe('pagination and filtering', () => {
    it('caps the page size so a client cannot ask for unbounded work', async () => {
      await request(server())
        .get('/clients?limit=100000')
        .set(auth(owner.accessToken))
        .expect(400);
    });

    it('returns metadata a client can page through', async () => {
      const response = await request(server())
        .get('/clients?page=1&limit=1')
        .set(auth(owner.accessToken))
        .expect(200);

      const page = body<PaginatedResult<ClientDto>>(response);
      expect(page.items).toHaveLength(1);
      expect(page.page).toBe(1);
      expect(page.totalPages).toBe(page.total);
    });

    it('filters contracts by status', async () => {
      const response = await request(server())
        .get('/contracts?status=CANCELLED')
        .set(auth(owner.accessToken))
        .expect(200);

      const page = body<PaginatedResult<ContractDto>>(response);
      expect(
        page.items.every((c) => c.status === ContractStatusDto.CANCELLED),
      ).toBe(true);
    });

    it('hides archived clients by default and shows them on request', async () => {
      const created = await request(server())
        .post('/clients')
        .set(auth(owner.accessToken))
        .send({ name: 'To Archive', email: `archive-${run}@x.test` })
        .expect(201);

      const id = body<ClientDto>(created).id;

      const archived = await request(server())
        .delete(`/clients/${id}`)
        .set(auth(owner.accessToken))
        .expect(200);

      // Archived, not deleted — the row and its history survive.
      expect(body<ClientDto>(archived).archivedAt).not.toBeNull();

      const defaultList = await request(server())
        .get('/clients?limit=100')
        .set(auth(owner.accessToken))
        .expect(200);
      expect(
        body<PaginatedResult<ClientDto>>(defaultList).items.map((c) => c.id),
      ).not.toContain(id);

      const withArchived = await request(server())
        .get('/clients?limit=100&includeArchived=true')
        .set(auth(owner.accessToken))
        .expect(200);
      expect(
        body<PaginatedResult<ClientDto>>(withArchived).items.map((c) => c.id),
      ).toContain(id);
    });
  });

  describe('permissions', () => {
    it('lets a MEMBER read clients and contracts', async () => {
      await request(server())
        .get('/clients')
        .set(auth(member.accessToken))
        .expect(200);

      await request(server())
        .get('/contracts')
        .set(auth(member.accessToken))
        .expect(200);
    });

    it('forbids a MEMBER from creating a client', async () => {
      await request(server())
        .post('/clients')
        .set(auth(member.accessToken))
        .send({ name: 'Nope', email: `nope-${run}@x.test` })
        .expect(403);
    });

    it('forbids a MEMBER from creating or editing a contract', async () => {
      await request(server())
        .post('/contracts')
        .set(auth(member.accessToken))
        .send({
          clientId,
          title: 'Nope',
          milestones: [{ title: 'M', amount: 1, dueDate: '2026-09-01' }],
        })
        .expect(403);

      await request(server())
        .patch(`/contracts/${contractId}`)
        .set(auth(member.accessToken))
        .send({ title: 'Renamed by member' })
        .expect(403);
    });

    it('lets a MEMBER complete a milestone — doing the work is their job', async () => {
      const fresh = await createContract('Member completes');
      await request(server())
        .patch(`/contracts/${fresh}`)
        .set(auth(owner.accessToken))
        .send({ status: 'ACTIVE' })
        .expect(200);

      const contract = await request(server())
        .get(`/contracts/${fresh}`)
        .set(auth(owner.accessToken))
        .expect(200);

      const target = body<ContractDto>(contract).milestones[0].id;

      await request(server())
        .patch(`/contracts/${fresh}/milestones/${target}/complete`)
        .set(auth(member.accessToken))
        .expect(200);
    });
  });

  describe('tenant isolation', () => {
    it("hides another tenant's client", async () => {
      await request(server())
        .get(`/clients/${clientId}`)
        .set(auth(otherTenant.accessToken))
        .expect(404);
    });

    it("hides another tenant's contract", async () => {
      await request(server())
        .get(`/contracts/${contractId}`)
        .set(auth(otherTenant.accessToken))
        .expect(404);
    });

    it("refuses to attach a contract to another tenant's client", async () => {
      // The client lookup runs under the caller's tenant context, so the row
      // is invisible rather than merely rejected.
      await request(server())
        .post('/contracts')
        .set(auth(otherTenant.accessToken))
        .send({
          clientId,
          title: 'Cross-tenant steal',
          milestones: [{ title: 'M', amount: 1, dueDate: '2026-09-01' }],
        })
        .expect(404);
    });

    it("refuses to complete another tenant's milestone", async () => {
      await request(server())
        .patch(`/contracts/${contractId}/milestones/${milestoneId}/complete`)
        .set(auth(otherTenant.accessToken))
        .expect(404);
    });
  });

  async function createContract(title: string): Promise<string> {
    const response = await request(server())
      .post('/contracts')
      .set(auth(owner.accessToken))
      .send({
        clientId,
        title,
        milestones: [{ title: 'M', amount: 100, dueDate: '2026-09-01' }],
      })
      .expect(201);

    return body<ContractDto>(response).id;
  }
});
