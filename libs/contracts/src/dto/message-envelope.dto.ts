import { IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Base shape every RPC payload extends.
 *
 * The envelope carries the cross-cutting metadata that must survive a hop
 * between services. It lives in the payload rather than in transport headers
 * because the Redis transport does not give us a portable header channel —
 * see the Sprint 6 correlation-ID work, which formalises this.
 */
export abstract class MessageEnvelopeDto {
  /** Generated at the gateway per HTTP request, propagated down every hop. */
  @IsUUID()
  correlationId!: string;

  /** Populated from JWT claims in Sprint 1. Absent for unauthenticated calls. */
  @IsOptional()
  @IsString()
  tenantId?: string;
}
