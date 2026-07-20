import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { JwtModule } from '@nestjs/jwt';

import { tenantsServiceEnvSchema } from '@forge/contracts';
import {
  RpcCorrelationInterceptor,
  buildLoggerConfig,
} from '@forge/observability';
import { PrismaModule } from '@forge/prisma';

import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { TokenService } from './auth/token.service';
import { HealthController } from './health.controller';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: tenantsServiceEnvSchema,
      // Surface every bad var at once instead of one per restart cycle.
      validationOptions: { abortEarly: false },
    }),
    LoggerModule.forRoot(buildLoggerConfig('tenants-service')),
    PrismaModule,
    // Registered without a secret: TokenService passes one explicitly per
    // signing call, because access and refresh tokens use different secrets.
    JwtModule.register({}),
  ],
  controllers: [HealthController, AuthController, UsersController],
  providers: [
    {
      // Async context does not survive Redis, so the correlation ID arrives in
      // the message payload and is rebound here for the handler's logs.
      provide: APP_INTERCEPTOR,
      useClass: RpcCorrelationInterceptor,
    },
    AuthService,
    TokenService,
    UsersService,
  ],
})
export class AppModule {}
