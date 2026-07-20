import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { contractsServiceEnvSchema } from '@forge/contracts';
import {
  RpcCorrelationInterceptor,
  buildLoggerConfig,
} from '@forge/observability';
import { PrismaModule } from '@forge/prisma';

import { ClientsController } from './clients/clients.controller';
import { ClientsService } from './clients/clients.service';
import { ContractsController } from './contracts/contracts.controller';
import { ContractsService } from './contracts/contracts.service';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: contractsServiceEnvSchema,
      // Surface every bad var at once instead of one per restart cycle.
      validationOptions: { abortEarly: false },
    }),
    LoggerModule.forRoot(buildLoggerConfig('contracts-service')),
    PrismaModule,
  ],
  controllers: [HealthController, ClientsController, ContractsController],
  providers: [
    {
      // Async context does not survive Redis, so the correlation ID arrives in
      // the message payload and is rebound here for the handler's logs.
      provide: APP_INTERCEPTOR,
      useClass: RpcCorrelationInterceptor,
    },
    ClientsService,
    ContractsService,
  ],
})
export class AppModule {}
