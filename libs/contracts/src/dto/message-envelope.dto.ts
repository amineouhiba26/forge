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

/**
 * Wraps a client-supplied DTO with the metadata the gateway adds on the way in.
 *
 * The distinction matters: a request DTO describes what a *client* may send and
 * is validated against untrusted input, while this describes what a downstream
 * service *receives*. Making the HTTP DTOs extend the envelope directly would
 * force callers to supply a `correlationId` the gateway is supposed to
 * generate — and, worse, let a client pick its own `tenantId`.
 */
export type Enveloped<T> = T & {
  correlationId: string;
  tenantId?: string;
};
