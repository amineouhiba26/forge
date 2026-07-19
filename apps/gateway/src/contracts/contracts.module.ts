import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RpcClientsModule } from '../rpc/rpc-clients.module';
import { ContractsController } from './contracts.controller';

@Module({
  imports: [RpcClientsModule, AuthModule],
  controllers: [ContractsController],
})
export class ContractsModule {}
