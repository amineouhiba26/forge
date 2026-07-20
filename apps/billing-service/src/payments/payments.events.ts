export class PaymentSucceededEvent {
  constructor(
    public readonly tenantId: string,
    public readonly invoiceId: string,
    public readonly paymentId: string,
    public readonly amount: string,
    public readonly currency: string,
    public readonly correlationId: string,
  ) {}
}

export class PaymentFailedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly invoiceId: string,
    public readonly reason: string,
    public readonly correlationId: string,
  ) {}
}

/**
 * The notification trigger the backlog asks for.
 *
 * Separate from `PaymentSucceededEvent` on purpose: that one is a statement
 * about the *payment*, this one about the *invoice reaching a terminal state*.
 * They coincide today, but a partial payment or a credit note would separate
 * them, and a subscriber that wants "tell the client it is settled" should not
 * have to re-derive that from payment mechanics.
 *
 * Sprint 5 subscribes to this to send the receipt email.
 */
export class InvoicePaidEvent {
  constructor(
    public readonly tenantId: string,
    public readonly invoiceId: string,
    public readonly correlationId: string,
  ) {}
}
