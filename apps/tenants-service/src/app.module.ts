import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { tenantsServiceEnvSchema } from '@forge/contracts';
import { PrismaModule } from '@forge/prisma';

import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: tenantsServiceEnvSchema,
      // Surface every bad var at once instead of one per restart cycle.
      validationOptions: { abortEarly: false },
    }),
    PrismaModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
