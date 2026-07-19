import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { workerServiceEnvSchema } from '@forge/contracts';

import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: workerServiceEnvSchema,
      // Surface every bad var at once instead of one per restart cycle.
      validationOptions: { abortEarly: false },
    }),
    // No PrismaModule: the worker owns no tables. It reacts to queue jobs and
    // reports results back over the transport — Sprint 5 builds that out.
  ],
  controllers: [HealthController],
})
export class AppModule {}
