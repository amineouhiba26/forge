import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  PingRequestDto,
  PingResponseDto,
  WORKER_PATTERNS,
} from '@forge/contracts';

@Controller()
export class HealthController {
  @MessagePattern(WORKER_PATTERNS.PING)
  ping(@Payload() payload: PingRequestDto): PingResponseDto {
    return {
      service: 'worker-service',
      reply: 'pong',
      correlationId: payload.correlationId,
      respondedAt: new Date().toISOString(),
    };
  }
}
