import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  PingRequestDto,
  PingResponseDto,
  TENANTS_PATTERNS,
} from '@forge/contracts';

@Controller()
export class HealthController {
  @MessagePattern(TENANTS_PATTERNS.PING)
  ping(@Payload() payload: PingRequestDto): PingResponseDto {
    return {
      service: 'tenants-service',
      reply: 'pong',
      correlationId: payload.correlationId,
      respondedAt: new Date().toISOString(),
    };
  }
}
