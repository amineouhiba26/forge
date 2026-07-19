import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { gatewayEnvSchema } from '@forge/contracts';

import { HealthModule } from './health/health.module';
import { PingModule } from './ping/ping.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: gatewayEnvSchema,
      validationOptions: { abortEarly: false },
    }),
    HealthModule,
    PingModule,
  ],
})
export class AppModule {}
