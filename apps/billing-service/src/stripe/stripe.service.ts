import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

export interface CreatePaymentIntentInput {
  invoiceId: string;
  tenantId: string;
  /** Minor units — cents. Stripe does not accept decimals. */
  amountInCents: number;
  currency: string;
  correlationId: string;
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe;

  constructor(private readonly config: ConfigService) {
    this.stripe = new Stripe(
      this.config.getOrThrow<string>('STRIPE_SECRET_KEY'),
      // Pinned rather than floating. Stripe ships breaking changes behind
      // dated API versions, and leaving this implicit means an SDK upgrade can
      // silently change payload shapes in production. It must match the
      // version the installed SDK is typed against.
      { apiVersion: '2026-06-24.dahlia' },
    );
  }

  /**
   * Creates a PaymentIntent for an invoice.
   *
   * Two things travel in `metadata`, and they are what make the webhook
   * possible: a Stripe webhook arrives with **no authentication and no tenant
   * context**, so there is nothing to scope a database lookup by. Stripe
   * echoes metadata back on every event for the intent, so after the signature
   * proves the payload came from Stripe, this is a trustworthy way to recover
   * which tenant and invoice the event belongs to.
   *
   * The alternative — looking the invoice up by payment-intent ID with no
   * tenant context — cannot work: RLS resolves an unset tenant to zero rows,
   * by design.
   */
  async createPaymentIntent(
    input: CreatePaymentIntentInput,
  ): Promise<Stripe.PaymentIntent> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amountInCents,
        currency: input.currency.toLowerCase(),
        metadata: {
          invoiceId: input.invoiceId,
          tenantId: input.tenantId,
          // Carried so the whole payment journey stays greppable by one ID,
          // including the part that happens days later inside a webhook.
          correlationId: input.correlationId,
        },
      },
      {
        // Stripe's own idempotency: if this exact request is retried — a
        // timeout, a redeployed pod, a double-clicked button — Stripe returns
        // the original intent instead of charging a second time. Keyed on the
        // invoice because one invoice must only ever have one intent.
        idempotencyKey: `invoice-${input.invoiceId}`,
      },
    );

    this.logger.log(
      `PaymentIntent ${intent.id} created for invoice ${input.invoiceId} ` +
        `(correlationId=${input.correlationId})`,
    );

    return intent;
  }

  /**
   * Confirms Stripe is reachable and the API key is accepted.
   *
   * `balance.retrieve` is the cheapest authenticated call available — it
   * touches no resource this system owns and creates nothing, so a health
   * probe running every few seconds cannot cause side effects. An unauthenticated
   * ping would prove only that Stripe is up, not that *this* service can talk
   * to it, which is the question being asked.
   */
  async checkReachable(): Promise<void> {
    await this.stripe.balance.retrieve();
  }

  /**
   * Verifies a webhook signature and parses the event.
   *
   * Takes the **raw body**, not a parsed object. The signature is computed over
   * the exact bytes Stripe sent, and `JSON.parse` followed by `JSON.stringify`
   * does not reliably reproduce them — key order, whitespace and number
   * formatting can all differ. A re-serialised body fails verification even
   * when it is genuine, which is the classic way this gets "fixed" by
   * disabling the check.
   *
   * Throws if the signature is absent, malformed, forged, or outside the
   * tolerance window — replay protection is part of what the signature buys.
   */
  constructEvent(rawBody: string, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET'),
    );
  }
}
