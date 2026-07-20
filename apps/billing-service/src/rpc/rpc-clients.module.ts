import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';

import { buildRedisTransportOptions } from '@forge/contracts';

export const TENANTS_CLIENT = 'TENANTS_CLIENT';
export const CONTRACTS_CLIENT = 'CONTRACTS_CLIENT';
export const WORKER_CLIENT = 'WORKER_CLIENT';

/**
 * Outbound RPC clients for billing-service.
 *
 * Billing talks to three services: tenants (for the tax country), contracts
 * (for the milestone being invoiced) and worker (for PDF rendering). Each one
 * is a service boundary rather than a table it could have joined against.
 */
@Module({
  imports: [
    ClientsModule.register([
      { name: TENANTS_CLIENT, ...buildRedisTransportOptions() },
      { name: CONTRACTS_CLIENT, ...buildRedisTransportOptions() },
      { name: WORKER_CLIENT, ...buildRedisTransportOptions() },
    ]),
  ],
  exports: [ClientsModule],
})
export class RpcClientsModule {}
