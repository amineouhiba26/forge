import { Controller, Get, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

import {
  BILLING_PATTERNS,
  CONTRACTS_PATTERNS,
  TENANTS_PATTERNS,
  WORKER_PATTERNS,
} from '@forge/contracts';
import type { AggregateHealthDto, ServiceHealthDto } from '@forge/contracts';

import { Public } from '../auth/public.decorator';
import { CircuitBreakerService } from '../rpc/circuit-breaker.service';
import {
  BILLING_CLIENT,
  CONTRACTS_CLIENT,
  TENANTS_CLIENT,
  WORKER_CLIENT,
} from '../rpc/rpc-clients.module';

/** Short: a health check that waits 5s for a dead service is not a health check. */
const HEALTH_TIMEOUT_MS = 2500;

@Controller('health')
export class HealthController {
  constructor(
    @Inject(TENANTS_CLIENT) private readonly tenants: ClientProxy,
    @Inject(CONTRACTS_CLIENT) private readonly contracts: ClientProxy,
    @Inject(BILLING_CLIENT) private readonly billing: ClientProxy,
    @Inject(WORKER_CLIENT) private readonly worker: ClientProxy,
    private readonly breakers: CircuitBreakerService,
  ) {}

  /**
   * Is *this process* alive?
   *
   * Deliberately checks nothing else. A liveness probe that fails because a
   * dependency is down gets the container restarted — which fixes nothing and
   * takes away the one process that could still serve cached reads or return
   * a useful error.
   */
  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * The aggregate view: every service's own report, plus circuit state.
   *
   * Each service runs its *own* checks and reports them — the gateway does not
   * reach into anyone else's database. It only asks, and records what it hears
   * or that it heard nothing.
   */
  @Public()
  @Get()
  async check(): Promise<AggregateHealthDto> {
    const [tenants, contracts, billing, worker] = await Promise.all([
      this.ask('tenants-service', this.tenants, TENANTS_PATTERNS.HEALTH),
      this.ask('contracts-service', this.contracts, CONTRACTS_PATTERNS.HEALTH),
      this.ask('billing-service', this.billing, BILLING_PATTERNS.HEALTH),
      this.ask('worker-service', this.worker, WORKER_PATTERNS.HEALTH),
    ]);

    const services = {
      'tenants-service': tenants,
      'contracts-service': contracts,
      'billing-service': billing,
      'worker-service': worker,
    };

    const degraded = Object.values(services).some(
      (report) => report.status !== 'ok',
    );

    return {
      status: degraded ? 'degraded' : 'ok',
      checkedAt: new Date().toISOString(),
      services,
    };
  }

  /**
   * Asks one service for its health.
   *
   * Not routed through the circuit breaker, on purpose. A breaker exists to
   * stop sending doomed traffic; the health check *is* the traffic that finds
   * out whether it is still doomed. Behind an open circuit it would report
   * "unreachable" forever, long after recovery — a monitor that cannot observe
   * recovery is worse than none.
   *
   * The breaker's state is reported alongside instead, which is the useful
   * signal: "billing is up, and the gateway has stopped calling it" is a real
   * and otherwise invisible situation.
   */
  private async ask(
    name: string,
    client: ClientProxy,
    pattern: string,
  ): Promise<
    | (ServiceHealthDto & { circuit: string })
    | {
        service: string;
        status: 'unreachable';
        message: string;
        circuit: string;
      }
  > {
    const circuit = this.breakers.stateOf(name);

    try {
      const report = await firstValueFrom(
        client
          .send<ServiceHealthDto>(pattern, {})
          .pipe(timeout(HEALTH_TIMEOUT_MS)),
      );

      return { ...report, circuit };
    } catch (error) {
      // Reported, never thrown. `/health` must answer even when everything
      // behind it is down — that is the case it exists for.
      return {
        service: name,
        status: 'unreachable',
        message: (error as Error).message || 'No response',
        circuit,
      };
    }
  }
}
