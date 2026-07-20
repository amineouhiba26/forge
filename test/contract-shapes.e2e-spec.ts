import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { ClientProxy, ClientProxyFactory } from '@nestjs/microservices';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

import {
  CONTRACTS_PATTERNS,
  TENANTS_PATTERNS,
  buildRedisTransportOptions,
} from '@forge/contracts';
import type {
  AuthResultDto,
  ClientDto,
  ContractDto,
  MilestoneForBillingDto,
  PaginatedResult,
  TenantDto,
} from '@forge/contracts';

import { AppModule as ContractsModule } from '../apps/contracts-service/src/app.module';
import { AppModule as TenantsModule } from '../apps/tenants-service/src/app.module';

/**
 * Response-shape contract tests.
 *
 * The pattern tests in `contract.e2e-spec.ts` prove a handler exists for every
 * declared message. They deliberately cannot catch the failure the backlog
 * actually names — *"a breaking DTO change should fail CI, not production"* —
 * and it is worth being precise about why:
 *
 * Renaming a constant in `libs/contracts` changes the producer and the
 * consumer *simultaneously*, because both import it. Nothing drifts. The real
 * risk is a **field**: a service stops returning `tenantId`, or renames
 * `total` to `amount`, while the DTO the gateway reads still promises it. Both
 * sides compile, because the service builds its response object inline and
 * TypeScript never compares it to what the caller destructures.
 *
 * So these call each service for real and assert the response carries every
 * field the shared DTO declares. That is the contract: not "a handler
 * answered", but "it answered with the shape the caller was promised".
 */
describe('Response shapes match the shared DTOs (e2e)', () => {
  const services: Awaited<ReturnType<typeof NestFactory.createMicroservice>>[] =
    [];
  let client: ClientProxy;

  const run = Date.now();
  let tenantId: string;
  let clientId: string;
  let milestoneId: string;

  beforeAll(async () => {
    for (const module of [TenantsModule, ContractsModule]) {
      const service = await NestFactory.createMicroservice<MicroserviceOptions>(
        module,
        { ...buildRedisTransportOptions(), logger: false },
      );
      await service.listen();
      services.push(service);
    }

    client = ClientProxyFactory.create(buildRedisTransportOptions());
    await client.connect();

    // Seeded over RPC rather than through the gateway: what is under test is
    // the service-to-service contract, so the gateway must not be in the path.
    const auth = await send<AuthResultDto>(TENANTS_PATTERNS.SIGNUP, {
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenant: { name: `Shapes ${run}`, country: 'FR' },
      owner: {
        email: `shapes-${run}@acme.test`,
        password: 'a-long-enough-password',
      },
    });
    tenantId = auth.user.tenantId;

    const created = await send<ClientDto>(CONTRACTS_PATTERNS.CREATE_CLIENT, {
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId,
      name: 'Wayne Enterprises',
      email: `client-${run}@wayne.test`,
    });
    clientId = created.id;

    const contract = await send<ContractDto>(
      CONTRACTS_PATTERNS.CREATE_CONTRACT,
      {
        correlationId: '11111111-1111-4111-8111-111111111111',
        tenantId,
        clientId,
        title: 'Shape check',
        milestones: [{ title: 'Work', amount: 1000, dueDate: '2026-09-01' }],
      },
    );
    milestoneId = contract.milestones[0].id;
  });

  afterAll(async () => {
    await client?.close();
    for (const service of services) await service.close();
  });

  function send<T>(pattern: string, payload: unknown): Promise<T> {
    return firstValueFrom(
      client.send<T>(pattern, payload).pipe(timeout(10_000)),
    );
  }

  /**
   * Asserts every field is present, and reports *which* are missing.
   *
   * `toHaveProperty` one field at a time would stop at the first failure; a
   * contract break usually removes or renames several at once, and seeing all
   * of them is the difference between one fix and four rounds of CI.
   */
  function expectShape(actual: object, fields: string[]): void {
    const missing = fields.filter((field) => !(field in actual));
    expect(missing).toEqual([]);
  }

  describe('tenants-service', () => {
    it('GET_TENANT returns every field TenantDto promises', async () => {
      const tenant = await send<TenantDto>(TENANTS_PATTERNS.GET_TENANT, {
        tenantId,
        correlationId: '11111111-1111-4111-8111-111111111111',
      });

      // billing reads `country` to resolve the tax rate. Losing it would
      // silently produce 0% VAT on every invoice — a wrong number on a legal
      // document, with nothing failing.
      expectShape(tenant, ['id', 'name', 'country']);
    });

    it('SIGNUP returns a usable AuthResultDto', async () => {
      const auth = await send<AuthResultDto>(TENANTS_PATTERNS.SIGNUP, {
        correlationId: '11111111-1111-4111-8111-111111111111',
        tenant: { name: `Shapes2 ${run}`, country: 'DE' },
        owner: {
          email: `shapes2-${run}@acme.test`,
          password: 'a-long-enough-password',
        },
      });

      expectShape(auth, ['user', 'tokens']);
      expectShape(auth.user, ['id', 'tenantId', 'email', 'role']);
      expectShape(auth.tokens, ['accessToken', 'refreshToken']);
    });

    it('LIST_USERS returns objects the gateway can render', async () => {
      const users = await send<{ id: string }[]>(TENANTS_PATTERNS.LIST_USERS, {
        tenantId,
        correlationId: '11111111-1111-4111-8111-111111111111',
      });

      expect(users.length).toBeGreaterThan(0);
      expectShape(users[0], ['id', 'tenantId', 'email', 'role']);
    });
  });

  describe('contracts-service', () => {
    it('GET_CLIENT returns every field ClientDto promises', async () => {
      const found = await send<ClientDto>(CONTRACTS_PATTERNS.GET_CLIENT, {
        tenantId,
        clientId,
        correlationId: '11111111-1111-4111-8111-111111111111',
      });

      expectShape(found, [
        'id',
        'tenantId',
        'name',
        'email',
        'companyName',
        'archivedAt',
        'createdAt',
        'updatedAt',
      ]);
    });

    it('LIST_CLIENTS returns the pagination envelope, not a bare array', async () => {
      const page = await send<PaginatedResult<ClientDto>>(
        CONTRACTS_PATTERNS.LIST_CLIENTS,
        {
          tenantId,
          page: 1,
          limit: 10,
          correlationId: '11111111-1111-4111-8111-111111111111',
        },
      );

      // The gateway returns this envelope verbatim. Dropping `total` would
      // break every client's paging without breaking a single type.
      expectShape(page, ['items', 'total', 'page', 'limit', 'totalPages']);
    });

    it('GET_CONTRACT returns milestones with their money as strings', async () => {
      const contract = await send<ContractDto>(
        CONTRACTS_PATTERNS.GET_CONTRACT,
        {
          tenantId,
          contractId: (
            await send<PaginatedResult<ContractDto>>(
              CONTRACTS_PATTERNS.LIST_CONTRACTS,
              {
                tenantId,
                page: 1,
                limit: 1,
                correlationId: '11111111-1111-4111-8111-111111111111',
              },
            )
          ).items[0].id,
          correlationId: '11111111-1111-4111-8111-111111111111',
        },
      );

      expectShape(contract, [
        'id',
        'tenantId',
        'clientId',
        'title',
        'status',
        'currency',
        'milestones',
      ]);
      expectShape(contract.milestones[0], [
        'id',
        'contractId',
        'title',
        'amount',
        'dueDate',
        'status',
      ]);

      // Money crosses the wire as a string with its minor units. A change to a
      // JSON number would pass every field-presence check and reintroduce the
      // float rounding the Decimal column exists to prevent.
      expect(typeof contract.milestones[0].amount).toBe('string');
      expect(contract.milestones[0].amount).toMatch(/^\d+\.\d{2}$/);
    });

    it('GET_MILESTONE_FOR_BILLING returns exactly what billing needs', async () => {
      const milestone = await send<MilestoneForBillingDto>(
        CONTRACTS_PATTERNS.GET_MILESTONE_FOR_BILLING,
        {
          tenantId,
          milestoneId,
          correlationId: '11111111-1111-4111-8111-111111111111',
        },
      );

      // This projection exists solely for billing's CreateInvoiceHandler.
      // `status` and `contractStatus` are what it refuses to invoice on;
      // losing either would make it invoice work that is not done.
      expectShape(milestone, [
        'id',
        'contractId',
        'clientId',
        'title',
        'amount',
        'currency',
        'status',
        'contractStatus',
      ]);
    });
  });

  describe('error shapes', () => {
    it('a not-found reply carries a status the gateway can map', async () => {
      const error = await send(CONTRACTS_PATTERNS.GET_CLIENT, {
        tenantId,
        clientId: '11111111-1111-4111-8111-111111111111',
        correlationId: '11111111-1111-4111-8111-111111111111',
      }).catch((e: unknown) => e);

      // The gateway maps `status` to an HTTP code and treats a statusless
      // failure as an unreachable service (503). A downstream that stopped
      // setting `status` would turn every 404 into a false outage signal —
      // and would count against the circuit breaker.
      expect(error).toMatchObject({ status: 404 });
    });
  });
});
