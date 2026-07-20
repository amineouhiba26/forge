import { Global, Module } from '@nestjs/common';

import { CircuitBreakerService } from '../rpc/circuit-breaker.service';
import { RpcService } from './rpc.service';

/**
 * Global so every feature module gets the same breaker instances.
 *
 * This matters more than the convenience: circuit state is per-downstream and
 * must be *shared*. If each module built its own breaker, ten failed calls
 * spread across three controllers would look like three separate services
 * having a bad day, and the circuit would never reach its threshold.
 */
@Global()
@Module({
  providers: [CircuitBreakerService, RpcService],
  exports: [CircuitBreakerService, RpcService],
})
export class RpcInfrastructureModule {}
