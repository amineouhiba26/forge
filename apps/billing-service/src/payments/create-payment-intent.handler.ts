import { Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { RpcException } from '@nestjs/microservices';

import type { PaymentIntentDto } from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

import { StripeService } from '../stripe/stripe.service';
import { CreatePaymentIntentCommand } from './payments.commands';

@CommandHandler(CreatePaymentIntentCommand)
export class CreatePaymentIntentHandler implements ICommandHandler<CreatePaymentIntentCommand> {
  private readonly logger = new Logger(CreatePaymentIntentHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  async execute(
    command: CreatePaymentIntentCommand,
  ): Promise<PaymentIntentDto> {
    const { tenantId, invoiceId, correlationId } = command;

    const invoice = await this.prisma.forTenant(tenantId, (tx) =>
      tx.invoice.findUnique({ where: { id: invoiceId } }),
    );

    if (!invoice) {
      throw new RpcException({ status: 404, message: 'Invoice not found' });
    }

    if (invoice.status === 'PAID') {
      throw new RpcException({
        status: 409,
        message: 'Invoice is already paid',
      });
    }

    // Only an issued invoice can be collected. A PENDING one has no PDF yet,
    // and a GENERATION_FAILED one has nothing to send the client — asking for
    // money against a document that does not exist is not defensible.
    if (invoice.status !== 'ISSUED') {
      throw new RpcException({
        status: 409,
        message: `Cannot collect payment for an invoice in state ${invoice.status}`,
      });
    }

    const amountInCents = toMinorUnits(invoice.total.toFixed(2));

    const intent = await this.stripe.createPaymentIntent({
      invoiceId,
      tenantId,
      amountInCents,
      currency: invoice.currency,
      correlationId,
    });

    // Recorded so the invoice can be reconciled against Stripe by hand if the
    // webhook is ever lost. The column is unique, so a second intent cannot be
    // silently attached to the same invoice.
    await this.prisma.forTenant(tenantId, (tx) =>
      tx.invoice.update({
        where: { id: invoiceId },
        data: { stripePaymentIntentId: intent.id },
      }),
    );

    this.logger.log(
      `PaymentIntent ${intent.id} attached to invoice ${invoiceId} ` +
        `(correlationId=${correlationId})`,
    );

    return {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
      amountInCents,
      currency: invoice.currency,
    };
  }
}

/**
 * Converts a decimal string to integer minor units.
 *
 * Via the string, never `Math.round(total * 100)`: the float path turns
 * `19.99 * 100` into `1998.9999999999998`, and a charge that is a cent short
 * is a reconciliation problem that surfaces weeks later. The stored value is
 * already exactly two decimal places, so the digits can just be read.
 */
export function toMinorUnits(amount: string): number {
  const [whole, fraction = '00'] = amount.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
}
