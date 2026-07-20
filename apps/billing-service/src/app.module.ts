import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';

import { billingServiceEnvSchema } from '@forge/contracts';
import { PrismaModule } from '@forge/prisma';

import { HealthController } from './health.controller';
import { CreateInvoiceHandler } from './invoices/commands/create-invoice.handler';
import {
  MarkGenerationFailedHandler,
  MarkInvoiceIssuedHandler,
  RetryPdfGenerationHandler,
} from './invoices/commands/invoice-state.handlers';
import { InvoicesController } from './invoices/invoices.controller';
import {
  GetInvoiceHandler,
  ListInvoicesHandler,
} from './invoices/queries/invoice.query-handlers';
import { InvoiceSaga } from './invoices/sagas/invoice.saga';
import { RpcClientsModule } from './rpc/rpc-clients.module';
import { TaxService } from './tax/tax.service';

const CommandHandlers = [
  CreateInvoiceHandler,
  MarkInvoiceIssuedHandler,
  MarkGenerationFailedHandler,
  RetryPdfGenerationHandler,
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
    PrismaModule,
    RpcClientsModule,
    // Provides CommandBus, QueryBus and EventBus, and wires up everything
    // decorated with @CommandHandler, @QueryHandler or @Saga.
    CqrsModule,
  ],
  controllers: [HealthController, InvoicesController],
  providers: [
    TaxService,
    ...CommandHandlers,
    ...QueryHandlers,
    // The saga is an ordinary provider; @Saga() is what registers its
    // event → command mapping with the bus.
    InvoiceSaga,
  ],
})
export class AppModule {}
