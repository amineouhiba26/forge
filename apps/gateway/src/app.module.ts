import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { gatewayEnvSchema } from '@forge/contracts';
import {
  CorrelationIdMiddleware,
  buildLoggerConfig,
} from '@forge/observability';

import { RpcInfrastructureModule } from './common/rpc.module';
import { AuthModule } from './auth/auth.module';
import { JwtCaslGuard } from './auth/jwt-casl.guard';
import { ClientsModule } from './clients/clients.module';
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
    LoggerModule.forRoot(buildLoggerConfig('gateway')),
    // Rate-limit config, read from env so a deployment can tune it and the
    // e2e suites can loosen it. The guard itself is applied only to the auth
    // controller (see AuthController) rather than globally — the brute-force
    // surface is the credential endpoints, and throttling the whole API would
    // also throttle a tenant's legitimate bulk use of its own data.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.getOrThrow<number>('AUTH_THROTTLE_TTL_MS'),
            limit: config.getOrThrow<number>('AUTH_THROTTLE_LIMIT'),
          },
        ],
      }),
    }),
    RpcInfrastructureModule,
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
