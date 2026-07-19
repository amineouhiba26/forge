import { Module } from '@nestjs/common';

import { RpcClientsModule } from '../clients/clients.module';
import { PingController } from './ping.controller';
import { PingService } from './ping.service';

@Module({
  imports: [RpcClientsModule],
  controllers: [PingController],
  providers: [PingService],
})
export class PingModule {}
