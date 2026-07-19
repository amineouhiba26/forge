import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  PingRequestDto,
  PingResponseDto,
  BILLING_PATTERNS,
} from '@forge/contracts';

@Controller()
export class HealthController {
  @MessagePattern(BILLING_PATTERNS.PING)
  ping(@Payload() payload: PingRequestDto): PingResponseDto {
    return {
      service: 'billing-service',
      reply: 'pong',
      correlationId: payload.correlationId,
      respondedAt: new Date().toISOString(),
    };
  }
}
