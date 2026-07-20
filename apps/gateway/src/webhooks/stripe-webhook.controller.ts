import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Request } from 'express';

import { BILLING_PATTERNS } from '@forge/contracts';
import type { StripeWebhookResult } from '@forge/contracts';

import { Public } from '../auth/public.decorator';
import { CorrelationId } from '../common/correlation-id.decorator';
import { RpcService } from '../common/rpc.service';
import { BILLING_CLIENT } from '../rpc/rpc-clients.module';

/**
 * Stripe's webhook endpoint.
 *
 * **Why the gateway and not billing-service** — the backlog asks for this
 * decision and its justification:
 *
 * The gateway is the only process in this system that speaks HTTP. Putting the
 * endpoint on billing-service would mean giving a pure Redis microservice its
 * own HTTP server, and with it a second public ingress to TLS-terminate,
 * rate-limit, log and monitor. One ingress is one place to get those right.
 *
 * But the gateway learns *nothing* about Stripe. It forwards the untouched
 * body and the signature header to billing-service, which owns both secrets
 * and does the verification. So this is not the usual trade of "convenient
 * ingress in exchange for leaking a domain concern outward" — the gateway is a
 * dumb pipe here, and every Stripe credential stays inside the service that
 * owns payments.
 */
@Controller('webhooks')
export class StripeWebhookController {
  constructor(
    @Inject(BILLING_CLIENT) private readonly billing: ClientProxy,
    private readonly rpc: RpcService,
  ) {}

  /**
   * Public by necessity: Stripe cannot present a JWT. The signature check in
   * billing-service is what authenticates this endpoint instead — it is not a
   * secondary safeguard, it is the *only* one.
   */
  @Public()
  @Post('stripe')
  // 200, not 201. Stripe treats any 2xx as acknowledged, but this creates no
  // resource from the caller's point of view.
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
    @CorrelationId() correlationId: string,
  ): Promise<StripeWebhookResult> {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    // Populated by `rawBody: true` in main.ts. If it is missing, the exact
    // bytes are gone and verification could only ever fail — so fail loudly
    // here rather than reporting a confusing "invalid signature".
    const rawBody = request.rawBody;

    if (!rawBody) {
      throw new BadRequestException(
        'Raw body unavailable — the webhook route must bypass the JSON parser',
      );
    }

    return this.rpc.send(
      'billing-service',
      this.billing.send(BILLING_PATTERNS.HANDLE_STRIPE_WEBHOOK, {
        rawBody: rawBody.toString('utf8'),
        signature,
        correlationId,
      }),
    );
  }
}
