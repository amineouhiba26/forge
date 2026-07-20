import { Module } from '@nestjs/common';

import { RpcClientsModule } from '../rpc/rpc-clients.module';
import { HealthController } from './health.controller';

@Module({
  imports: [RpcClientsModule],
  controllers: [HealthController],
})
export class HealthModule {}
