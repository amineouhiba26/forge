import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
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
    const intent = await this.callStripe(
      'createPaymentIntent',
      input.correlationId,
      () =>
        this.stripe.paymentIntents.create(
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
        ),
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
    try {
      await this.stripe.balance.retrieve();
    } catch (error) {
      const stripeError = error as Stripe.errors.StripeError;

      // The provider's own message is logged, never re-thrown. `/health` is a
      // public, unauthenticated endpoint and this message propagates straight
      // into its response — Stripe's reads "Invalid API Key provided:
      // sk_test_****************************6430", which hands an anonymous
      // caller the key's environment, format and last four characters. The
      // check still reports `down`; only the provider's wording is withheld.
      this.logger.error(
        `Stripe reachability check failed (${stripeError?.type ?? 'unknown'}): ` +
          `${stripeError?.message ?? String(error)}`,
      );

      throw new Error(mapStripeError(stripeError).message);
    }
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

  /**
   * Runs a Stripe call and gives its failures a status.
   *
   * The gateway's contract is that a downstream's own errors always carry a
   * status, because the downstream maps them itself. An unmapped error is
   * indistinguishable from *no answer at all*, so the gateway reports
   * "billing-service is not responding" and — worse — counts it against the
   * circuit breaker. A bad Stripe key would then take every billing route
   * offline for every tenant, which is a payment-provider problem escalated
   * into a service outage.
   *
   * Statuses are chosen so a caller learns whether retrying helps:
   *   402 — the card was declined; the client can try another
   *   429 — Stripe is rate-limiting us; retry later
   *   503 — could not reach Stripe at all; genuinely transient
   *   502 — Stripe rejected *us* (bad key, bad request). Retrying will not help
   *
   * Stripe's own message is logged but never returned. It can echo a masked
   * key, and provider internals are not a client's business.
   */
  private async callStripe<T>(
    operation: string,
    correlationId: string,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const stripeError = error as Stripe.errors.StripeError;
      const type: string = stripeError?.type ?? 'unknown';

      const { status, message } = mapStripeError(stripeError);

      this.logger.error(
        `Stripe ${operation} failed (${type}): ${stripeError?.message ?? error} ` +
          `(correlationId=${correlationId})`,
      );

      throw new RpcException({ status, message });
    }
  }
}

/** Maps a Stripe error class onto an HTTP status and a safe message. */
function mapStripeError(error: Stripe.errors.StripeError): {
  status: number;
  message: string;
} {
  switch (error?.type) {
    case 'StripeCardError':
      // The only case the end client can act on.
      return { status: 402, message: error.message ?? 'The card was declined' };
    case 'StripeRateLimitError':
      return {
        status: 429,
        message: 'Payment provider is rate limiting; retry shortly',
      };
    case 'StripeConnectionError':
      // 502 rather than 503: billing itself is healthy and answering. A 503
      // would read as "billing is unavailable" and would count against
      // billing's circuit breaker, taking its unrelated routes down too.
      return {
        status: 502,
        message: 'Could not reach the payment provider; retry shortly',
      };
    case 'StripeAuthenticationError':
    case 'StripePermissionError':
    case 'StripeInvalidRequestError':
    default:
      // Our configuration or our request is wrong. A client retry cannot fix
      // it, so it must not look transient.
      return { status: 502, message: 'Payment provider rejected the request' };
  }
}
