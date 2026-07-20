import 'dotenv/config';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import {
  AuthResultDto,
  AuthUserDto,
  buildRedisTransportOptions,
} from '@forge/contracts';

import { AppModule as GatewayModule } from '../apps/gateway/src/app.module';
import { AppModule as TenantsModule } from '../apps/tenants-service/src/app.module';
import { assertNoCompetingServices } from './support/no-competing-services';

/**
 * Supertest types `response.body` as `any`, which disables type checking for
 * every assertion made against it. Narrowing once here keeps the tests honest
 * about the shape they expect.
 */
function body<T>(response: { body: unknown }): T {
  return response.body as T;
}

/** The server handle, typed so `request()` does not receive an `any`. */
function server() {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

let app: INestApplication;

/**
 * End-to-end against real Postgres and Redis — `docker compose up` must be
 * running, and migrations applied.
 *
 * Nothing here is mocked, deliberately. The property being tested is that
 * Postgres refuses to return another tenant's rows; a mocked database would
 * only prove that the mock behaves as written. Sprint 7 replaces the
 * dependency on a running stack with Testcontainers.
 */
describe('Auth & tenant isolation (e2e)', () => {
  let tenantsService: Awaited<
    ReturnType<typeof NestFactory.createMicroservice>
  >;

  // Unique per run so repeated runs cannot collide on the per-tenant email
  // uniqueness constraint.
  const run = Date.now();
  const tenantA = {
    tenant: { name: `Acme ${run}`, country: 'FR' },
    owner: { email: `owner-a-${run}@acme.test`, password: 'a-long-password-1' },
  };
  const tenantB = {
    tenant: { name: `Globex ${run}`, country: 'DE' },
    owner: {
      email: `owner-b-${run}@globex.test`,
      password: 'a-long-password-2',
    },
  };

  let sessionA: { userId: string; tenantId: string; accessToken: string };
  let sessionB: { userId: string; tenantId: string; accessToken: string };

  beforeAll(async () => {
    // Fails fast and explains itself if another stack is on this Redis.
    await assertNoCompetingServices();

    // The downstream service runs in-process, listening on the same Redis the
    // gateway's clients publish to.
    tenantsService = await NestFactory.createMicroservice<MicroserviceOptions>(
      TenantsModule,
      { ...buildRedisTransportOptions(), logger: false },
    );
    await tenantsService.listen();

    const moduleRef = await Test.createTestingModule({
      imports: [GatewayModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // Mirrors main.ts — without it the DTO validation under test is absent.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await tenantsService?.close();
  });

  async function signup(payload: typeof tenantA) {
    const response = await request(server())
      .post('/auth/signup')
      .send(payload)
      .expect(201);

    const result = body<AuthResultDto>(response);

    return {
      userId: result.user.id,
      tenantId: result.user.tenantId,
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
    };
  }

  describe('signup', () => {
    it('creates a tenant with its owner and returns a token pair', async () => {
      const result = await signup(tenantA);
      sessionA = result;

      expect(result.tenantId).toBeDefined();
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });

    it('creates a second, independent tenant', async () => {
      sessionB = await signup(tenantB);

      expect(sessionB.tenantId).not.toBe(sessionA.tenantId);
    });

    it('rejects a password below the minimum length', async () => {
      await request(server())
        .post('/auth/signup')
        .send({
          tenant: { name: 'Too Weak', country: 'FR' },
          owner: { email: `weak-${run}@x.test`, password: 'short' },
        })
        .expect(400);
    });

    it('rejects an unknown country code', async () => {
      await request(server())
        .post('/auth/signup')
        .send({
          tenant: { name: 'Nowhere', country: 'ZZZ' },
          owner: {
            email: `nowhere-${run}@x.test`,
            password: 'a-long-password',
          },
        })
        .expect(400);
    });
  });

  describe('login', () => {
    it('returns a token pair for valid credentials', async () => {
      const response = await request(server())
        .post('/auth/login')
        .send({
          tenantId: sessionA.tenantId,
          email: tenantA.owner.email,
          password: tenantA.owner.password,
        })
        .expect(200);

      expect(body<AuthResultDto>(response).user.role).toBe('OWNER');
    });

    it('rejects a wrong password', async () => {
      await request(server())
        .post('/auth/login')
        .send({
          tenantId: sessionA.tenantId,
          email: tenantA.owner.email,
          password: 'not-the-password',
        })
        .expect(401);
    });

    it("rejects A's credentials presented against B's tenant", async () => {
      // The user genuinely exists — just not in that tenant. RLS scopes the
      // lookup, so the row is unreachable rather than merely filtered out.
      await request(server())
        .post('/auth/login')
        .send({
          tenantId: sessionB.tenantId,
          email: tenantA.owner.email,
          password: tenantA.owner.password,
        })
        .expect(401);
    });
  });

  describe('protected routes', () => {
    it('rejects a request with no token', async () => {
      await request(server()).get('/users').expect(401);
    });

    it('rejects a token signed with the wrong secret', async () => {
      const forged =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJzdWIiOiJ4IiwidGVuYW50SWQiOiJ4Iiwicm9sZSI6Ik9XTkVSIiwiZXhwIjo5OTk5OTk5OTk5fQ.' +
        'ZmFrZS1zaWduYXR1cmU';

      await request(server())
        .get('/users')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });

    it('accepts a valid token', async () => {
      await request(server())
        .get('/users')
        .set('Authorization', `Bearer ${sessionA.accessToken}`)
        .expect(200);
    });
  });

  describe('tenant isolation', () => {
    it('shows each tenant only its own users', async () => {
      const responseA = await request(server())
        .get('/users')
        .set('Authorization', `Bearer ${sessionA.accessToken}`)
        .expect(200);

      const responseB = await request(server())
        .get('/users')
        .set('Authorization', `Bearer ${sessionB.accessToken}`)
        .expect(200);

      const emailsA = body<AuthUserDto[]>(responseA).map((u) => u.email);
      const emailsB = body<AuthUserDto[]>(responseB).map((u) => u.email);

      expect(emailsA).toContain(tenantA.owner.email);
      expect(emailsA).not.toContain(tenantB.owner.email);
      expect(emailsB).toContain(tenantB.owner.email);
      expect(emailsB).not.toContain(tenantA.owner.email);
    });

    it("hides B's user from A even with the exact ID", async () => {
      // 404 and not 403: a distinguishable "forbidden" would confirm the ID
      // names a real user, which is itself a cross-tenant leak.
      await request(server())
        .get(`/users/${sessionB.userId}`)
        .set('Authorization', `Bearer ${sessionA.accessToken}`)
        .expect(404);
    });

    it('ignores a tenantId the client injects into the request body', async () => {
      // The crafted request from the backlog's Definition of Done. The gateway
      // takes tenantId from verified JWT claims, so the body is inert — and
      // even if it were not, RLS would refuse the rows.
      const response = await request(server())
        .get('/users')
        .set('Authorization', `Bearer ${sessionA.accessToken}`)
        .send({ tenantId: sessionB.tenantId })
        .expect(200);

      const emails = body<AuthUserDto[]>(response).map((u) => u.email);
      expect(emails).not.toContain(tenantB.owner.email);
    });
  });

  describe('refresh token rotation', () => {
    it('rotates the token and invalidates the presented one', async () => {
      const session = await signup({
        tenant: { name: `Rotate ${run}`, country: 'FR' },
        owner: {
          email: `rotate-${run}@x.test`,
          password: 'a-long-password-3',
        },
      });

      const rotated = await request(server())
        .post('/auth/refresh')
        .send({
          tenantId: session.tenantId,
          refreshToken: session.refreshToken,
        })
        .expect(200);

      const rotatedTokens = body<AuthResultDto>(rotated).tokens;
      expect(rotatedTokens.refreshToken).not.toBe(session.refreshToken);

      // Replaying the original is what a thief would do with a stolen copy.
      await request(server())
        .post('/auth/refresh')
        .send({
          tenantId: session.tenantId,
          refreshToken: session.refreshToken,
        })
        .expect(401);

      // ...and the replacement dies with it, because reuse means the chain is
      // compromised and there is no way to tell which holder is legitimate.
      await request(server())
        .post('/auth/refresh')
        .send({
          tenantId: session.tenantId,
          refreshToken: rotatedTokens.refreshToken,
        })
        .expect(401);
    });

    it('revokes the refresh token on logout', async () => {
      const session = await signup({
        tenant: { name: `Logout ${run}`, country: 'FR' },
        owner: {
          email: `logout-${run}@x.test`,
          password: 'a-long-password-4',
        },
      });

      await request(server())
        .post('/auth/logout')
        .send({
          tenantId: session.tenantId,
          refreshToken: session.refreshToken,
        })
        .expect(200);

      await request(server())
        .post('/auth/refresh')
        .send({
          tenantId: session.tenantId,
          refreshToken: session.refreshToken,
        })
        .expect(401);
    });
  });

  describe('correlation ID', () => {
    it('assigns one per request and returns it', async () => {
      const response = await request(server()).get('/health').expect(200);

      expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('honours a valid inbound ID so a trace can span systems', async () => {
      const inbound = '11111111-2222-4333-8444-555555555555';

      const response = await request(server())
        .get('/health')
        .set('x-correlation-id', inbound)
        .expect(200);

      expect(response.headers['x-correlation-id']).toBe(inbound);
    });

    it('replaces a malformed inbound ID rather than echoing it', async () => {
      // Arbitrary client input must not reach logs or response headers.
      //
      // A newline — the classic log-injection payload — cannot be tested from
      // here: Node's HTTP client rejects it before the request is sent. So the
      // check uses input that is malformed but legal to transmit, which is
      // what the middleware's UUID validation actually has to catch.
      const hostile = 'a'.repeat(500) + '-not-a-uuid';

      const response = await request(server())
        .get('/health')
        .set('x-correlation-id', hostile)
        .expect(200);

      const echoed = response.headers['x-correlation-id'];
      expect(echoed).not.toBe(hostile);
      expect(echoed).toMatch(/^[0-9a-f-]{36}$/i);
    });
  });
});
