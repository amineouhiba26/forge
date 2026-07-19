import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';

import { buildRedisTransportOptions } from '@forge/contracts';

/** Injection tokens for the downstream RPC clients. */
export const TENANTS_CLIENT = 'TENANTS_CLIENT';
export const CONTRACTS_CLIENT = 'CONTRACTS_CLIENT';
export const BILLING_CLIENT = 'BILLING_CLIENT';
export const WORKER_CLIENT = 'WORKER_CLIENT';

/**
 * One `ClientProxy` per downstream service.
 *
 * They all point at the same Redis instance today — the separation is by
 * message pattern, not by connection. Keeping four distinct tokens anyway
 * means moving one service onto its own broker later is a change to this
 * module only, not to every call site.
 */
@Module({
  imports: [
    ClientsModule.register([
      { name: TENANTS_CLIENT, ...buildRedisTransportOptions() },
      { name: CONTRACTS_CLIENT, ...buildRedisTransportOptions() },
      { name: BILLING_CLIENT, ...buildRedisTransportOptions() },
      { name: WORKER_CLIENT, ...buildRedisTransportOptions() },
    ]),
  ],
  exports: [ClientsModule],
})
export class RpcClientsModule {}
