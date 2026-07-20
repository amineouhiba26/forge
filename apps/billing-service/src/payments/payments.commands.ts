export class CreatePaymentIntentCommand {
  constructor(
    public readonly tenantId: string,
    public readonly invoiceId: string,
    public readonly correlationId: string,
  ) {}
}

/**
 * Handles one inbound Stripe webhook.
 *
 * Carries the raw body rather than a parsed event: verification has to run
 * against the exact bytes Stripe signed, and doing it inside the handler keeps
 * "is this genuine?" and "what does it mean?" in one place.
 */
export class ProcessStripeWebhookCommand {
  constructor(
    public readonly rawBody: string,
    public readonly signature: string,
    public readonly correlationId: string,
  ) {}
}
