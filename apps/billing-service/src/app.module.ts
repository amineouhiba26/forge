import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { CqrsModule } from '@nestjs/cqrs';

import { QUEUES, billingServiceEnvSchema } from '@forge/contracts';
import {
  RpcCorrelationInterceptor,
  buildLoggerConfig,
} from '@forge/observability';
import { PrismaModule } from '@forge/prisma';

import { HealthController } from './health.controller';
import { CreateInvoiceHandler } from './invoices/commands/create-invoice.handler';
import {
  MarkGenerationFailedHandler,
  MarkInvoiceIssuedHandler,
} from './invoices/commands/invoice-state.handlers';
import { InvoicesController } from './invoices/invoices.controller';
import {
  GetInvoiceHandler,
  ListInvoicesHandler,
} from './invoices/queries/invoice.query-handlers';
import { InvoiceSaga } from './invoices/sagas/invoice.saga';
import { WorkerEventsController } from './invoices/worker-events.controller';
import { CreatePaymentIntentHandler } from './payments/create-payment-intent.handler';
import { PaymentsController } from './payments/payments.controller';
import { ProcessStripeWebhookHandler } from './payments/process-webhook.handler';
import { StripeService } from './stripe/stripe.service';
import { RpcClientsModule } from './rpc/rpc-clients.module';
import { TaxService } from './tax/tax.service';

const CommandHandlers = [
  CreateInvoiceHandler,
  MarkInvoiceIssuedHandler,
  MarkGenerationFailedHandler,
  CreatePaymentIntentHandler,
  ProcessStripeWebhookHandler,
];

const QueryHandlers = [GetInvoiceHandler, ListInvoicesHandler];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: billingServiceEnvSchema,
      // Surface every bad var at once instead of one per restart cycle.
      validationOptions: { abortEarly: false },
    }),
    LoggerModule.forRoot(buildLoggerConfig('billing-service')),
    PrismaModule,
    RpcClientsModule,
    // Billing is the queue *producer*; worker-service is the consumer. Both
    // point at the same Redis, and neither knows the other exists — which is
    // the decoupling the RPC version did not have.
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
        },
      }),
    }),
    BullModule.registerQueue({ name: QUEUES.PDF }, { name: QUEUES.EMAIL }),
    // Provides CommandBus, QueryBus and EventBus, and wires up everything
    // decorated with @CommandHandler, @QueryHandler or @Saga.
    CqrsModule,
  ],
  controllers: [
    HealthController,
    InvoicesController,
    PaymentsController,
    WorkerEventsController,
  ],
  providers: [
    {
      // Async context does not survive Redis, so the correlation ID arrives in
      // the message payload and is rebound here for the handler's logs.
      provide: APP_INTERCEPTOR,
      useClass: RpcCorrelationInterceptor,
    },
    TaxService,
    StripeService,
    ...CommandHandlers,
    ...QueryHandlers,
    // The saga is an ordinary provider; @Saga() is what registers its
    // event → command mapping with the bus.
    InvoiceSaga,
  ],
})
export class AppModule {}
