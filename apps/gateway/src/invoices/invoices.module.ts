import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RpcClientsModule } from '../rpc/rpc-clients.module';
import { InvoicesController } from './invoices.controller';

@Module({
  imports: [RpcClientsModule, AuthModule],
  controllers: [InvoicesController],
})
export class InvoicesModule {}
