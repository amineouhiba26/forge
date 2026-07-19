import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { billingServiceEnvSchema } from '@forge/contracts';
import { PrismaModule } from '@forge/prisma';

import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: billingServiceEnvSchema,
      // Surface every bad var at once instead of one per restart cycle.
      validationOptions: { abortEarly: false },
    }),
    PrismaModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
