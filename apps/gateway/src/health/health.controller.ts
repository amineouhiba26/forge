import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  MicroserviceHealthIndicator,
} from '@nestjs/terminus';

import { buildRedisTransportOptions } from '@forge/contracts';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly microservice: MicroserviceHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      // Redis is checked for real — it is the transport, so if it is down the
      // gateway can do nothing useful and should say so.
      () =>
        this.microservice.pingCheck('redis', {
          ...buildRedisTransportOptions(),
          timeout: 2000,
        }),
      // DB check is deliberately stubbed in Sprint 0: the gateway owns no
      // tables and must not hold a Prisma connection. It reports `stub: true`
      // rather than a bare `up`, so nobody reads this as a real signal.
      // Sprint 6 replaces it with a per-service check over the transport.
      () =>
        Promise.resolve({
          database: {
            status: 'up' as const,
            stub: true,
            note: 'not checked — gateway owns no tables (see Sprint 6)',
          },
        }),
    ]);
  }
}
