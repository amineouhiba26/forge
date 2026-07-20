import { Injectable, Optional } from '@nestjs/common';

import type { HealthIndicator, ServiceHealthDto } from '@forge/contracts';

/**
 * A named check a service runs against one of its dependencies.
 *
 * The contract is "throw if unhealthy" — whatever the check returns is
 * discarded, so the signature deliberately does not constrain it. Requiring
 * `void` would force callers to wrap perfectly good probes (`getJobCounts()`,
 * a `SELECT 1`) just to discard a value this never reads.
 */
export interface HealthCheck {
  name: string;
  check: () => unknown;
}

/** Individual checks get this long before being called down. */
const CHECK_TIMEOUT_MS = 2000;

/**
 * Runs a service's own dependency checks and reports them in a common shape.
 *
 * Each service declares what it actually depends on — tenants and contracts
 * need Postgres, the worker needs Postgres and its queues, billing needs
 * Postgres and Stripe. A single shared list would either check things a
 * service does not use (reporting failures it cannot cause) or miss things it
 * does.
 */
@Injectable()
export class ServiceHealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly serviceName: string,
    @Optional() private readonly checks: HealthCheck[] = [],
  ) {}

  async check(): Promise<ServiceHealthDto> {
    const results = await Promise.all(
      this.checks.map(async (check): Promise<[string, HealthIndicator]> => {
        try {
          await withTimeout(check.check(), CHECK_TIMEOUT_MS, check.name);
          return [check.name, { status: 'up' }];
        } catch (error) {
          // A failing dependency is reported, never thrown. A health endpoint
          // that 500s tells a probe the *service* is broken when the truth is
          // that one dependency is — and which one is the whole point.
          return [
            check.name,
            { status: 'down', message: (error as Error).message },
          ];
        }
      }),
    );

    const details = Object.fromEntries(results);
    const anyDown = results.some(
      ([, indicator]) => indicator.status === 'down',
    );

    return {
      service: this.serviceName,
      status: anyDown ? 'degraded' : 'ok',
      details,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}

/**
 * A check that hangs is worse than one that fails: without this the health
 * response never returns, and a probe cannot tell "slow" from "dead".
 */
async function withTimeout(
  work: unknown,
  ms: number,
  name: string,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} check timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
