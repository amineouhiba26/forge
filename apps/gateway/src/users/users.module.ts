import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RpcClientsModule } from '../rpc/rpc-clients.module';
import { UsersController } from './users.controller';

@Module({
  imports: [RpcClientsModule, AuthModule],
  controllers: [UsersController],
})
export class UsersModule {}
