import { Controller } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { BILLING_PATTERNS } from '@forge/contracts';
import type {
  CreatePaymentIntentRpcRequest,
  PaymentIntentDto,
  StripeWebhookRpcRequest,
  StripeWebhookResult,
} from '@forge/contracts';

import {
  CreatePaymentIntentCommand,
  ProcessStripeWebhookCommand,
} from './payments.commands';

@Controller()
export class PaymentsController {
  constructor(private readonly commandBus: CommandBus) {}

  @MessagePattern(BILLING_PATTERNS.CREATE_PAYMENT_INTENT)
  createIntent(
    @Payload() payload: CreatePaymentIntentRpcRequest,
  ): Promise<PaymentIntentDto> {
    return this.commandBus.execute(
      new CreatePaymentIntentCommand(
        payload.tenantId,
        payload.invoiceId,
        payload.correlationId,
      ),
    );
  }

  @MessagePattern(BILLING_PATTERNS.HANDLE_STRIPE_WEBHOOK)
  handleWebhook(
    @Payload() payload: StripeWebhookRpcRequest,
  ): Promise<StripeWebhookResult> {
    return this.commandBus.execute(
      new ProcessStripeWebhookCommand(
        payload.rawBody,
        payload.signature,
        payload.correlationId,
      ),
    );
  }
}
