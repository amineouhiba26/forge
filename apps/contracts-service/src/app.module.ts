import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { contractsServiceEnvSchema } from '@forge/contracts';
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
    PrismaModule,
  ],
  controllers: [HealthController, ClientsController, ContractsController],
  providers: [ClientsService, ContractsService],
})
export class AppModule {}
