import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

import {
  BILLING_PATTERNS,
  CONTRACTS_PATTERNS,
  PingResponseDto,
  TENANTS_PATTERNS,
  WORKER_PATTERNS,
} from '@forge/contracts';

import {
  BILLING_CLIENT,
  CONTRACTS_CLIENT,
  TENANTS_CLIENT,
  WORKER_CLIENT,
} from '../rpc/rpc-clients.module';

/** Sprint 0 proof-of-life: gateway sends a ping, each service answers pong. */
const RPC_TIMEOUT_MS = 5000;

@Injectable()
export class PingService {
  constructor(
    @Inject(TENANTS_CLIENT) private readonly tenants: ClientProxy,
    @Inject(CONTRACTS_CLIENT) private readonly contracts: ClientProxy,
    @Inject(BILLING_CLIENT) private readonly billing: ClientProxy,
    @Inject(WORKER_CLIENT) private readonly worker: ClientProxy,
  ) {}

  /** Round-trips every downstream service and reports each reply. */
  async pingAll(): Promise<PingResponseDto[]> {
    const correlationId = randomUUID();

    const targets: Array<[ClientProxy, string]> = [
      [this.tenants, TENANTS_PATTERNS.PING],
      [this.contracts, CONTRACTS_PATTERNS.PING],
      [this.billing, BILLING_PATTERNS.PING],
      [this.worker, WORKER_PATTERNS.PING],
    ];

    return Promise.all(
      targets.map(([client, pattern]) =>
        firstValueFrom(
          client
            // Without an explicit timeout an unreachable service leaves the
            // HTTP request hanging until the client gives up — Sprint 6
            // replaces this with a real circuit breaker.
            .send<PingResponseDto>(pattern, { correlationId, from: 'gateway' })
            .pipe(timeout(RPC_TIMEOUT_MS)),
        ),
      ),
    );
  }
}
