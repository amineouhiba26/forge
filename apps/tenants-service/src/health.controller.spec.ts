import { Test } from '@nestjs/testing';

import { PingRequestDto } from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

import { HealthController } from './health.controller';

describe('HealthController (tenants-service)', () => {
  let controller: HealthController;
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
      ],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  const request: PingRequestDto = {
    correlationId: '11111111-1111-4111-8111-111111111111',
    from: 'gateway',
  };

  describe('ping', () => {
    it('identifies itself and replies pong', () => {
      const response = controller.ping(request);

      expect(response.service).toBe('tenants-service');
      expect(response.reply).toBe('pong');
    });

    it('echoes the caller correlation ID back unchanged', () => {
      // The whole point of the ping: proving a request can be traced across
      // the hop. A freshly-generated ID would make it unverifiable.
      const response = controller.ping(request);

      expect(response.correlationId).toBe(request.correlationId);
    });

    it('stamps an ISO-8601 response time', () => {
      const response = controller.ping(request);

      expect(new Date(response.respondedAt).toISOString()).toBe(
        response.respondedAt,
      );
    });
  });

  describe('health check', () => {
    it('reports ok when its database answers', async () => {
      const report = await controller.check();

      expect(report.service).toBe('tenants-service');
      expect(report.status).toBe('ok');
      expect(report.details.database.status).toBe('up');
    });

    it('reports degraded rather than throwing when the database is down', async () => {
      queryRaw.mockRejectedValue(new Error('connection refused'));

      const report = await controller.check();

      // A health check that throws tells a probe the *service* is broken when
      // the truth is that one dependency is — and which one is the point.
      expect(report.status).toBe('degraded');
      expect(report.details.database.status).toBe('down');
      expect(report.details.database.message).toContain('connection refused');
    });

    it('reports uptime, so a restart loop is visible', async () => {
      const report = await controller.check();

      expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });
});
