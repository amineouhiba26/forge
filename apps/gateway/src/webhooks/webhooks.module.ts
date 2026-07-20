import { Module } from '@nestjs/common';

import { RpcClientsModule } from '../rpc/rpc-clients.module';
import { StripeWebhookController } from './stripe-webhook.controller';

@Module({
  imports: [RpcClientsModule],
  controllers: [StripeWebhookController],
})
export class WebhooksModule {}
