import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  PingRequestDto,
  PingResponseDto,
  CONTRACTS_PATTERNS,
} from '@forge/contracts';

@Controller()
export class HealthController {
  @MessagePattern(CONTRACTS_PATTERNS.PING)
  ping(@Payload() payload: PingRequestDto): PingResponseDto {
    return {
      service: 'contracts-service',
      reply: 'pong',
      correlationId: payload.correlationId,
      respondedAt: new Date().toISOString(),
    };
  }
}
