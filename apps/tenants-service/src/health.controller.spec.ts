import { Test } from '@nestjs/testing';

import { PingRequestDto } from '@forge/contracts';

import { HealthController } from './health.controller';

describe('HealthController (tenants-service)', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  const request: PingRequestDto = {
    correlationId: '11111111-1111-4111-8111-111111111111',
    from: 'gateway',
  };

  it('identifies itself and replies pong', () => {
    const response = controller.ping(request);

    expect(response.service).toBe('tenants-service');
    expect(response.reply).toBe('pong');
  });

  it('echoes the caller correlation ID back unchanged', () => {
    // The whole point of the ping: proving a request can be traced across the
    // hop. A freshly-generated ID here would make the round-trip unverifiable.
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
