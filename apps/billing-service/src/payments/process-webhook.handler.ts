import { Logger } from '@nestjs/common';
import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { RpcException } from '@nestjs/microservices';
import Stripe from 'stripe';

import type { StripeWebhookResult } from '@forge/contracts';
import { PrismaService, TenantScopedClient } from '@forge/prisma';

import { StripeService } from '../stripe/stripe.service';
import { ProcessStripeWebhookCommand } from './payments.commands';
import {
  InvoicePaidEvent,
  PaymentFailedEvent,
  PaymentSucceededEvent,
} from './payments.events';

/** Stripe event types this system acts on. Anything else is acknowledged and ignored. */
const HANDLED_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
] as const;

@CommandHandler(ProcessStripeWebhookCommand)
export class ProcessStripeWebhookHandler implements ICommandHandler<ProcessStripeWebhookCommand> {
  private readonly logger = new Logger(ProcessStripeWebhookHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly eventBus: EventBus,
  ) {}

  async execute(
    command: ProcessStripeWebhookCommand,
  ): Promise<StripeWebhookResult> {
    const { rawBody, signature, correlationId } = command;

    // ── 1. Authenticity ────────────────────────────────────────────────────
    // Before anything else. The endpoint is public and unauthenticated, so
    // without this an attacker could POST `payment_intent.succeeded` for any
    // invoice and mark it paid. This is the only thing standing between the
    // open internet and the payment state.
    let event: Stripe.Event;
    try {
      event = this.stripe.constructEvent(rawBody, signature);
    } catch (error) {
      this.logger.warn(
        `Rejected webhook with invalid signature: ${(error as Error).message} ` +
          `(correlationId=${correlationId})`,
      );

      // 400, not 500: the request was malformed or forged. A 500 would make
      // Stripe retry a payload that can never succeed.
      throw new RpcException({
        status: 400,
        message: 'Invalid webhook signature',
      });
    }

    if (!isHandledEvent(event.type)) {
      // Acknowledged without being recorded. Stripe sends dozens of event
      // types; treating an unhandled one as an error would make it retry
      // forever, and recording it would claim we acted on it.
      this.logger.debug(
        `Ignoring unhandled event type ${event.type} (correlationId=${correlationId})`,
      );
      return { received: true, processed: false };
    }

    const intent = event.data.object as Stripe.PaymentIntent;
    const tenantId = intent.metadata?.tenantId;
    const invoiceId = intent.metadata?.invoiceId;

    // Metadata is trustworthy *because* the signature verified — these are the
    // values this system set when creating the intent, echoed back by Stripe.
    if (!tenantId || !invoiceId) {
      this.logger.error(
        `Event ${event.id} has no tenantId/invoiceId metadata — cannot route it ` +
          `(correlationId=${correlationId})`,
      );

      // 200-equivalent: retrying will not add the metadata. Better to swallow
      // it here, loudly, than to have Stripe redeliver it indefinitely.
      return { received: true, processed: false };
    }

    // ── 2. Idempotency + state change, in ONE transaction ──────────────────
    return this.prisma.forTenant(tenantId, async (tx) => {
      try {
        // Inserted first so a replay aborts before touching payment state.
        // The unique constraint on event_id is what makes this safe: a
        // "have I seen this?" SELECT followed by an INSERT is two statements,
        // and two concurrent deliveries both read "no" before either writes.
        await tx.processedWebhook.create({
          data: { eventId: event.id, eventType: event.type, tenantId },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Already applied. This is the expected path for a Stripe retry or
          // a duplicate delivery — not an error condition.
          this.logger.log(
            `Event ${event.id} already processed — no-op ` +
              `(correlationId=${correlationId})`,
          );

          return { received: true, processed: false };
        }

        throw error;
      }

      // Reaching here means this transaction owns the event. If anything below
      // throws, the dedupe row rolls back with it — so a genuine failure can
      // still be retried by Stripe rather than being permanently swallowed.
      if (event.type === 'payment_intent.succeeded') {
        await this.applySuccess(tx, tenantId, invoiceId, intent, correlationId);
      } else {
        await this.applyFailure(tx, tenantId, invoiceId, intent, correlationId);
      }

      return { received: true, processed: true };
    });
  }

  private async applySuccess(
    tx: TenantScopedClient,
    tenantId: string,
    invoiceId: string,
    intent: Stripe.PaymentIntent,
    correlationId: string,
  ): Promise<void> {
    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });

    if (!invoice) {
      throw new RpcException({ status: 404, message: 'Invoice not found' });
    }

    const amount = fromMinorUnits(intent.amount);

    const payment = await tx.payment.upsert({
      // Keyed on Stripe's own ID. Even with the dedupe table in front, this is
      // the constraint that makes a duplicate Payment row impossible.
      where: { providerPaymentId: intent.id },
      create: {
        tenantId,
        invoiceId,
        provider: 'stripe',
        providerPaymentId: intent.id,
        amount,
        currency: intent.currency.toUpperCase(),
        status: 'SUCCEEDED',
      },
      update: { status: 'SUCCEEDED', failureReason: null },
    });

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'PAID',
        paidAt: invoice.paidAt ?? new Date(),
        lastPaymentError: null,
      },
    });

    this.logger.log(
      `Invoice ${invoiceId} PAID via ${intent.id} (correlationId=${correlationId})`,
    );

    this.eventBus.publish(
      new PaymentSucceededEvent(
        tenantId,
        invoiceId,
        payment.id,
        amount.toFixed(2),
        intent.currency.toUpperCase(),
        correlationId,
      ),
    );

    // The notification trigger. Sprint 5 subscribes to send the receipt.
    this.eventBus.publish(
      new InvoicePaidEvent(tenantId, invoiceId, correlationId),
    );
  }

  private async applyFailure(
    tx: TenantScopedClient,
    tenantId: string,
    invoiceId: string,
    intent: Stripe.PaymentIntent,
    correlationId: string,
  ): Promise<void> {
    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });

    if (!invoice) {
      throw new RpcException({ status: 404, message: 'Invoice not found' });
    }

    const reason =
      intent.last_payment_error?.message ?? 'Payment failed without a reason';

    // ── Out-of-order delivery ──────────────────────────────────────────────
    // Webhooks are not ordered. A `payment_failed` for an earlier attempt can
    // arrive *after* the `payment_succeeded` that settled the invoice — a
    // declined card followed by a successful retry, delivered backwards.
    //
    // PAID is terminal. Un-paying an invoice because a stale failure turned up
    // late would be a data-corrupting bug that only shows under load, which is
    // exactly when nobody is watching.
    if (invoice.status === 'PAID') {
      this.logger.warn(
        `Ignoring late payment failure for already-paid invoice ${invoiceId}: ` +
          `${reason} (correlationId=${correlationId})`,
      );
      return;
    }

    await tx.payment.upsert({
      where: { providerPaymentId: intent.id },
      create: {
        tenantId,
        invoiceId,
        provider: 'stripe',
        providerPaymentId: intent.id,
        amount: fromMinorUnits(intent.amount),
        currency: intent.currency.toUpperCase(),
        status: 'FAILED',
        failureReason: reason,
      },
      update: { status: 'FAILED', failureReason: reason },
    });

    // The invoice status is deliberately unchanged. A failed attempt is a fact
    // about an attempt, not a state of the invoice — the money is still owed,
    // and the client can try again with another card. Only the reason is
    // recorded, so whoever chases it knows what happened.
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { lastPaymentError: reason },
    });

    this.logger.warn(
      `Payment failed for invoice ${invoiceId}: ${reason} ` +
        `(correlationId=${correlationId})`,
    );

    this.eventBus.publish(
      new PaymentFailedEvent(tenantId, invoiceId, reason, correlationId),
    );
  }
}

function isHandledEvent(type: string): type is (typeof HANDLED_EVENTS)[number] {
  return (HANDLED_EVENTS as readonly string[]).includes(type);
}

/** Stripe works in minor units; the database stores Decimal(12,2). */
function fromMinorUnits(amountInCents: number): number {
  return amountInCents / 100;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}
