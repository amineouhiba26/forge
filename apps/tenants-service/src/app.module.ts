import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { tenantsServiceEnvSchema } from '@forge/contracts';
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
    PrismaModule,
    // Registered without a secret: TokenService passes one explicitly per
    // signing call, because access and refresh tokens use different secrets.
    JwtModule.register({}),
  ],
  controllers: [HealthController, AuthController, UsersController],
  providers: [AuthService, TokenService, UsersService],
})
export class AppModule {}
