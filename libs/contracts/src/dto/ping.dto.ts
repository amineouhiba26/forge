import { IsISO8601, IsIn, IsString, IsUUID } from 'class-validator';

import { MessageEnvelopeDto } from './message-envelope.dto';

/** Request payload for every service's `*.health.ping` pattern. */
export class PingRequestDto extends MessageEnvelopeDto {
  @IsString()
  from!: string;
}

/** Reply payload for every service's `*.health.ping` pattern. */
export class PingResponseDto {
  @IsString()
  service!: string;

  @IsIn(['pong'])
  reply!: 'pong';

  /** Echoed back from the request so the caller can prove the round-trip. */
  @IsUUID()
  correlationId!: string;

  @IsISO8601()
  respondedAt!: string;
}
