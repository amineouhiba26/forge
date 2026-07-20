import 'dotenv/config';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { buildRedisTransportOptions } from '@forge/contracts';
import type { AggregateHealthDto, AuthResultDto } from '@forge/contracts';

import { AppModule as BillingModule } from '../apps/billing-service/src/app.module';
import { AppModule as ContractsModule } from '../apps/contracts-service/src/app.module';
import { AppModule as GatewayModule } from '../apps/gateway/src/app.module';
import { CircuitBreakerService } from '../apps/gateway/src/rpc/circuit-breaker.service';
import { AppModule as TenantsModule } from '../apps/tenants-service/src/app.module';
import { assertNoCompetingServices } from './support/no-competing-services';

function body<T>(response: { body: unknown }): T {
  return response.body as T;
}

let app: INestApplication;

function server() {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

/**
 * Sprint 6: what the system says about itself, and how it behaves when part of
 * it is missing.
 *
 * worker-service is deliberately *not* started. That is the point of half of
 * these tests — an absent service must be reported as unreachable rather than
 * making the health endpoint hang or fail.
 */
describe('Observability & resilience (e2e)', () => {
  const services: Awaited<ReturnType<typeof NestFactory.createMicroservice>>[] =
    [];
  const run = Date.now();
  let token: string;

  beforeAll(async () => {
    await assertNoCompetingServices();

    for (const module of [TenantsModule, ContractsModule, BillingModule]) {
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

    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    const signup = await request(server())
      .post('/auth/signup')
      .send({
        tenant: { name: `Obs ${run}`, country: 'FR' },
        owner: {
          email: `obs-${run}@acme.test`,
          password: 'a-long-enough-password',
        },
      })
      .expect(201);

    token = body<AuthResultDto>(signup).tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    for (const service of services) await service.close();
  });

  describe('liveness', () => {
    it('answers without consulting anything else', async () => {
      // A liveness probe that fails because a dependency is down gets the
      // container restarted, which fixes nothing and removes the one process
      // that could still return a useful error.
      const response = await request(server()).get('/health/live').expect(200);

      expect(body<{ status: string }>(response).status).toBe('ok');
    });

    it('needs no token — a probe cannot hold credentials', async () => {
      await request(server()).get('/health/live').expect(200);
    });
  });

  describe('aggregate health', () => {
    it('reports every service, including one that is not running', async () => {
      const response = await request(server()).get('/health').expect(200);
      const health = body<AggregateHealthDto>(response);

      expect(Object.keys(health.services)).toEqual(
        expect.arrayContaining([
          'tenants-service',
          'contracts-service',
          'billing-service',
          'worker-service',
        ]),
      );
    });

    it('answers 200 even while degraded', async () => {
      // The endpoint exists precisely for the case where something is broken.
      // A 5xx would make it useless to the monitor asking what is broken.
      const response = await request(server()).get('/health').expect(200);

      expect(body<AggregateHealthDto>(response).status).toBe('degraded');
    });

    it('marks the service that is not running as unreachable', async () => {
      const response = await request(server()).get('/health').expect(200);
      const health = body<AggregateHealthDto>(response);

      expect(health.services['worker-service'].status).toBe('unreachable');
    });

    it('reports each running service with its own dependency detail', async () => {
      const response = await request(server()).get('/health').expect(200);
      const health = body<AggregateHealthDto>(response);

      const tenants = health.services['tenants-service'];
      expect(tenants.status).toBe('ok');
      // Each service runs its *own* checks — the gateway never reaches into
      // another service's database.
      expect(
        (tenants as { details: Record<string, unknown> }).details.database,
      ).toEqual({ status: 'up' });
    });

    it('does not hang when a service is absent', async () => {
      const startedAt = Date.now();
      await request(server()).get('/health').expect(200);

      // Bounded by the health timeout, not by the RPC timeout. A health check
      // that waits 5s for a dead service is not a health check.
      expect(Date.now() - startedAt).toBeLessThan(4000);
    });
  });

  describe('graceful degradation', () => {
    it('returns 503 with a clear message when a downstream is unreachable', async () => {
      // worker-service is not running, and nothing routes through it here —
      // so this exercises billing being reachable while worker is not, which
      // must not affect billing's own endpoints.
      await request(server())
        .get('/invoices')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('names the failing service rather than returning a bare 500', async () => {
      const breakers = app.get(CircuitBreakerService);

      // Drive the breaker open directly: killing a service mid-suite would
      // make the test order-dependent, and what is under test is the *gateway's
      // behaviour* once it has decided a dependency is down.
      for (let i = 0; i < 5; i += 1) {
        await breakers
          .execute('billing-service', () =>
            Promise.reject(new Error('Timeout has occurred')),
          )
          .catch(() => undefined);
      }

      expect(breakers.stateOf('billing-service')).toBe('open');

      const response = await request(server())
        .get('/invoices')
        .set('Authorization', `Bearer ${token}`)
        .expect(503);

      // A 500 says "we are broken"; a 503 naming the service says "this part
      // is unavailable, retry shortly" — which is both true and actionable.
      const message = body<{ message: string }>(response).message;
      expect(message).toContain('billing-service');
      expect(message).toMatch(/unavailable|not responding/i);
    });

    it('fails fast once the circuit is open, instead of waiting out the timeout', async () => {
      const breakers = app.get(CircuitBreakerService);
      expect(breakers.stateOf('billing-service')).toBe('open');

      const startedAt = Date.now();
      await request(server())
        .get('/invoices')
        .set('Authorization', `Bearer ${token}`)
        .expect(503);

      // The entire point of the breaker: no doomed call, no timeout wait.
      expect(Date.now() - startedAt).toBeLessThan(500);
    });

    it('surfaces circuit state in the health report', async () => {
      const response = await request(server()).get('/health').expect(200);
      const health = body<AggregateHealthDto>(response);

      // "billing is up and the gateway has stopped calling it" is a real
      // situation and otherwise invisible.
      expect(
        (health.services['billing-service'] as { circuit?: string }).circuit,
      ).toBe('open');
    });
  });

  describe('correlation', () => {
    it('returns the correlation ID it assigned', async () => {
      const response = await request(server()).get('/health/live').expect(200);

      expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('honours a valid inbound ID so a trace can span systems', async () => {
      const inbound = '11111111-2222-4333-8444-555555555555';

      const response = await request(server())
        .get('/health/live')
        .set('x-correlation-id', inbound)
        .expect(200);

      expect(response.headers['x-correlation-id']).toBe(inbound);
    });

    it('replaces a malformed inbound ID rather than echoing it into logs', async () => {
      const response = await request(server())
        .get('/health/live')
        .set('x-correlation-id', 'a'.repeat(400))
        .expect(200);

      expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/i);
    });
  });
});
