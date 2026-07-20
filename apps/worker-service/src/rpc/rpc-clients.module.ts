import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';

import { buildRedisTransportOptions } from '@forge/contracts';

export const BILLING_CLIENT = 'BILLING_CLIENT';

/**
 * The worker's one outbound client.
 *
 * It only ever emits events — job completion and failure — never sends. The
 * worker finishes work and announces the outcome; whether billing is listening
 * is billing's problem.
 */
@Module({
  imports: [
    ClientsModule.register([
      { name: BILLING_CLIENT, ...buildRedisTransportOptions() },
    ]),
  ],
  exports: [ClientsModule],
})
export class RpcClientsModule {}
