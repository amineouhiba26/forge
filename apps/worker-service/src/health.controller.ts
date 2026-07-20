import { InjectQueue } from '@nestjs/bullmq';
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { Queue } from 'bullmq';

import {
  PingRequestDto,
  PingResponseDto,
  QUEUES,
  WORKER_PATTERNS,
} from '@forge/contracts';
import type { ServiceHealthDto } from '@forge/contracts';
import { ServiceHealthService } from '@forge/observability';
import { PrismaService } from '@forge/prisma';

@Controller()
export class HealthController {
  private readonly health: ServiceHealthService;

  constructor(
    prisma: PrismaService,
    @InjectQueue(QUEUES.PDF) pdfQueue: Queue,
    @InjectQueue(QUEUES.EMAIL) emailQueue: Queue,
  ) {
    this.health = new ServiceHealthService('worker-service', [
      { name: 'database', check: () => prisma.$queryRaw`SELECT 1` },
      // Checks the queues rather than Redis generally. A worker whose Redis is
      // up but whose queue client has come unstuck is still not doing work,
      // and `getJobCounts` exercises the path the jobs actually take.
      { name: 'queue:pdf', check: () => pdfQueue.getJobCounts() },
      { name: 'queue:email', check: () => emailQueue.getJobCounts() },
    ]);
  }

  @MessagePattern(WORKER_PATTERNS.PING)
  ping(@Payload() payload: PingRequestDto): PingResponseDto {
    return {
      service: 'worker-service',
      reply: 'pong',
      correlationId: payload.correlationId,
      respondedAt: new Date().toISOString(),
    };
  }

  @MessagePattern(WORKER_PATTERNS.HEALTH)
  check(): Promise<ServiceHealthDto> {
    return this.health.check();
  }
}
