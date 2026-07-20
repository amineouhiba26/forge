import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  TENANTS_PATTERNS,
  PingRequestDto,
  PingResponseDto,
} from '@forge/contracts';
import type { ServiceHealthDto } from '@forge/contracts';
import { ServiceHealthService } from '@forge/observability';
import { PrismaService } from '@forge/prisma';

@Controller()
export class HealthController {
  private readonly health: ServiceHealthService;

  constructor(prisma: PrismaService) {
    this.health = new ServiceHealthService('tenants-service', [
      {
        name: 'database',
        // A trivial query rather than a connection-pool inspection: it proves
        // the round trip works, which is what callers actually depend on.
        check: () => prisma.$queryRaw`SELECT 1`,
      },
    ]);
  }

  @MessagePattern(TENANTS_PATTERNS.PING)
  ping(@Payload() payload: PingRequestDto): PingResponseDto {
    return {
      service: 'tenants-service',
      reply: 'pong',
      correlationId: payload.correlationId,
      respondedAt: new Date().toISOString(),
    };
  }

  @MessagePattern(TENANTS_PATTERNS.HEALTH)
  check(): Promise<ServiceHealthDto> {
    return this.health.check();
  }
}
