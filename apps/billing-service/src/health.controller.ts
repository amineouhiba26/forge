import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  BILLING_PATTERNS,
  PingRequestDto,
  PingResponseDto,
} from '@forge/contracts';
import type { ServiceHealthDto } from '@forge/contracts';
import { ServiceHealthService } from '@forge/observability';
import { PrismaService } from '@forge/prisma';

import { StripeService } from './stripe/stripe.service';

@Controller()
export class HealthController {
  private readonly health: ServiceHealthService;

  constructor(prisma: PrismaService, stripe: StripeService) {
    this.health = new ServiceHealthService('billing-service', [
      { name: 'database', check: () => prisma.$queryRaw`SELECT 1` },
      {
        // The backlog asks for Stripe reachability here specifically, and it
        // belongs on billing rather than the gateway: billing is the only
        // service that would fail if Stripe were unreachable, and a health
        // check that reports a dependency the reporter does not use is noise.
        name: 'stripe',
        check: () => stripe.checkReachable(),
      },
    ]);
  }

  @MessagePattern(BILLING_PATTERNS.PING)
  ping(@Payload() payload: PingRequestDto): PingResponseDto {
    return {
      service: 'billing-service',
      reply: 'pong',
      correlationId: payload.correlationId,
      respondedAt: new Date().toISOString(),
    };
  }

  @MessagePattern(BILLING_PATTERNS.HEALTH)
  check(): Promise<ServiceHealthDto> {
    return this.health.check();
  }
}
