import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';

import { RpcClientsModule } from '../clients/clients.module';
import { AuthController } from './auth.controller';
import { AbilityFactory } from './casl/ability.factory';
import { JwtCaslGuard } from './jwt-casl.guard';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [RpcClientsModule, PassportModule],
  controllers: [AuthController],
  providers: [JwtStrategy, AbilityFactory, JwtCaslGuard],
  // Exported so AppModule can register the guard globally and other modules
  // can build abilities without re-providing the factory.
  exports: [AbilityFactory, JwtCaslGuard],
})
export class AuthModule {}
