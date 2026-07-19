import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';

import {
  BILLING_CLIENT,
  CONTRACTS_CLIENT,
  TENANTS_CLIENT,
  WORKER_CLIENT,
} from '../clients/clients.module';
import { PingService } from './ping.service';

/**
 * A ClientProxy stub that echoes back whichever service name it was given.
 *
 * Typed as `{ send: jest.Mock }` rather than `Partial<ClientProxy>`: the real
 * `send` is generic over its payload, and a concrete stub signature is not
 * assignable to it.
 */
type ClientStub = { send: jest.Mock };

function stubClient(service: string): ClientStub {
  return {
    send: jest.fn((_pattern: string, payload: { correlationId: string }) =>
      of({
        service,
        reply: 'pong',
        correlationId: payload.correlationId,
        respondedAt: new Date().toISOString(),
      }),
    ),
  };
}

describe('PingService', () => {
  const tenants = stubClient('tenants-service');
  const contracts = stubClient('contracts-service');
  const billing = stubClient('billing-service');
  const worker = stubClient('worker-service');

  async function buildService(
    overrides: Record<string, ClientStub> = {},
  ): Promise<PingService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PingService,
        {
          provide: TENANTS_CLIENT,
          useValue: overrides[TENANTS_CLIENT] ?? tenants,
        },
        { provide: CONTRACTS_CLIENT, useValue: contracts },
        { provide: BILLING_CLIENT, useValue: billing },
        { provide: WORKER_CLIENT, useValue: worker },
      ],
    }).compile();

    return moduleRef.get(PingService);
  }

  beforeEach(() => jest.clearAllMocks());

  it('pings every downstream service', async () => {
    const service = await buildService();

    const responses = await service.pingAll();

    expect(responses.map((r) => r.service)).toEqual([
      'tenants-service',
      'contracts-service',
      'billing-service',
      'worker-service',
    ]);
  });

  it('sends one shared correlation ID to all four services', async () => {
    const service = await buildService();

    const responses = await service.pingAll();

    // One ID per HTTP request, not per hop — that is what makes the whole
    // fan-out greppable as a single unit in Sprint 6's logs.
    const ids = new Set(responses.map((r) => r.correlationId));
    expect(ids.size).toBe(1);
  });

  it('rejects when a downstream service fails, rather than resolving partially', async () => {
    const service = await buildService({
      [TENANTS_CLIENT]: {
        send: jest.fn(() => throwError(() => new Error('service unreachable'))),
      },
    });

    await expect(service.pingAll()).rejects.toThrow('service unreachable');
  });
});
