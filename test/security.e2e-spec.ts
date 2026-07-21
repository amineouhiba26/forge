import 'dotenv/config';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import helmet from 'helmet';
import request from 'supertest';

import { buildRedisTransportOptions } from '@forge/contracts';

import { AppModule as GatewayModule } from '../apps/gateway/src/app.module';
import { AppModule as TenantsModule } from '../apps/tenants-service/src/app.module';

function server() {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

let app: INestApplication;

/**
 * Sprint 8 security pass: the two controls that have observable behaviour —
 * helmet response headers and auth rate limiting.
 *
 * The rate limit is set deliberately low for this suite (the functional suites
 * loosen it so they are not throttled), so the 429 can be provoked in a few
 * requests rather than ten thousand.
 */
describe('Security hardening (e2e)', () => {
  let tenantsService: Awaited<
    ReturnType<typeof NestFactory.createMicroservice>
  >;

  const THROTTLE_LIMIT = 4;

  beforeAll(async () => {
    tenantsService = await NestFactory.createMicroservice<MicroserviceOptions>(
      TenantsModule,
      { ...buildRedisTransportOptions(), logger: false },
    );
    await tenantsService.listen();

    const moduleRef = await Test.createTestingModule({
      imports: [GatewayModule],
    })
      // The limit is overridden at the DI token rather than through
      // `process.env`, because setting the variable would not work:
      // `ConfigModule` builds its validated config from the `.env` *file* and
      // `ConfigService.get` consults that before `process.env`, so the file's
      // loosened value wins over anything assigned at runtime. (That
      // precedence is a production footgun in its own right — see the
      // `.dockerignore` note about never shipping `.env` in an image.)
      .overrideProvider(getOptionsToken())
      .useValue({
        throttlers: [{ ttl: 60_000, limit: THROTTLE_LIMIT }],
      })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    // Mirrors main.ts, so the suite exercises the same middleware the real
    // process runs — helmet included.
    app.use(helmet({ contentSecurityPolicy: false }));
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

  describe('helmet security headers', () => {
    it('sets the hardening headers on a normal response', async () => {
      const response = await request(server()).get('/health').expect(200);

      // The header helmet is most relied on for: stops a browser MIME-sniffing
      // a response into something executable.
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      // helmet renames/removes the framework fingerprint that advertises the
      // stack to an attacker.
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('does not send a CSP header — the gateway serves a JSON API', async () => {
      const response = await request(server()).get('/health').expect(200);

      // Disabled deliberately (see main.ts): there is no HTML page whose
      // resource origins a CSP would constrain, and the default policy breaks
      // the dev Swagger UI.
      expect(response.headers['content-security-policy']).toBeUndefined();
    });
  });

  describe('auth rate limiting', () => {
    // A well-formed login for a tenant that does not exist. It is rejected with
    // 401 by the handler, but every attempt still counts against the throttle —
    // the guard runs before the handler, which is what makes it a brute-force
    // defence rather than a per-outcome one.
    const attempt = () =>
      request(server()).post('/auth/login').send({
        tenantId: '11111111-1111-4111-8111-111111111111',
        email: 'attacker@example.test',
        password: 'guessing-passwords',
      });

    it('allows requests up to the configured limit, then returns 429', async () => {
      // Requests must be sequential: fired in parallel they can slip past the
      // counter's read-modify-write, which would make the assertion flaky for
      // the wrong reason.
      for (let i = 0; i < THROTTLE_LIMIT; i += 1) {
        const response = await attempt();
        // Under the limit: reaches the handler and is rejected on credentials,
        // never throttled.
        expect(response.status).not.toBe(429);
      }

      const blocked = await attempt();
      expect(blocked.status).toBe(429);
    });

    it('does not rate-limit non-auth routes', async () => {
      // The guard is on the auth controller only. /health must stay reachable
      // no matter how hard the auth endpoints are being hammered — a load
      // balancer's health probe cannot be collateral damage of an attack.
      for (let i = 0; i < THROTTLE_LIMIT + 2; i += 1) {
        await request(server()).get('/health').expect(200);
      }
    });
  });
});
