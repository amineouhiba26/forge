import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { gatewayEnvSchema } from '@forge/contracts';

import { AuthModule } from './auth/auth.module';
import { JwtCaslGuard } from './auth/jwt-casl.guard';
import { ClientsModule } from './clients/clients.module';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { ContractsModule } from './contracts/contracts.module';
import { HealthModule } from './health/health.module';
import { PingModule } from './ping/ping.module';
import { UsersModule } from './users/users.module';

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
    PingModule,
    UsersModule,
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
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route, including public and health ones: a request that
    // fails auth is exactly the kind you want to be able to trace.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
