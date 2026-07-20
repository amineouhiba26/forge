import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { gatewayEnvSchema } from '@forge/contracts';

import { AuthModule } from './auth/auth.module';
import { JwtCaslGuard } from './auth/jwt-casl.guard';
import { ClientsModule } from './clients/clients.module';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { RequestLoggingInterceptor } from './common/request-logging.interceptor';
import { ContractsModule } from './contracts/contracts.module';
import { HealthModule } from './health/health.module';
import { InvoicesModule } from './invoices/invoices.module';
import { PingModule } from './ping/ping.module';
import { UsersModule } from './users/users.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: gatewayEnvSchema,
      validationOptions: { abortEarly: false },
    }),
    AuthModule,
    ClientsModule,
    ContractsModule,
    HealthModule,
    InvoicesModule,
    PingModule,
    UsersModule,
    WebhooksModule,
  ],
  providers: [
    {
      // Registered globally so authentication is the default and opting out is
      // explicit (`@Public()`). The inverse — protecting routes one decorator
      // at a time — fails open: forget one and the endpoint is simply public,
      // with nothing to signal it.
      provide: APP_GUARD,
      useClass: JwtCaslGuard,
    },
    {
      // Global, so every route appears in a trace without being remembered
      // per controller.
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route, including public and health ones: a request that
    // fails auth is exactly the kind you want to be able to trace.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
