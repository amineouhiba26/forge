import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Observable, firstValueFrom, timeout } from 'rxjs';

import { CircuitBreakerService } from '../rpc/circuit-breaker.service';

/** Downstream services are local; anything slower than this is a fault. */
export const RPC_TIMEOUT_MS = 5000;

interface RpcErrorShape {
  status?: number;
  message?: string;
}

/**
 * Every outbound RPC from the gateway goes through here.
 *
 * Two responsibilities that belong together:
 *
 * 1. **Translation.** An `RpcException` carrying `{status: 401}` would
 *    otherwise surface as a 500 — the gateway sees an unrecognised object and
 *    falls back — turning "wrong password" into "our server is broken".
 * 2. **Circuit breaking.** A downstream that is down should fail *fast* and
 *    say so, rather than making every request wait out the 5s timeout.
 *
 * The distinction the client sees:
 *
 * | Situation | Response |
 * | --- | --- |
 * | Downstream rejects (bad input, not found) | its own 4xx |
 * | Downstream unreachable, circuit closed | 503 after the timeout |
 * | Downstream unreachable, circuit open | **503 immediately** |
 *
 * A 4xx is never counted as a circuit failure: "that invoice does not exist"
 * is the service working correctly, and letting validation errors trip the
 * breaker would take a healthy service offline for being told about bad input.
 */
@Injectable()
export class RpcService {
  constructor(private readonly breaker: CircuitBreakerService) {}

  async send<T>(service: string, source: Observable<T>): Promise<T> {
    try {
      return await this.breaker.execute(service, () =>
        firstValueFrom(source.pipe(timeout(RPC_TIMEOUT_MS))),
      );
    } catch (error) {
      // Already an HttpException — including the 503 the breaker raises when
      // open. Pass it through untouched.
      if (error instanceof HttpException) throw error;

      const shape = error as RpcErrorShape;

      if (typeof shape?.status === 'number' && shape.status >= 400) {
        throw new HttpException(
          shape.message ?? 'Request failed',
          shape.status,
        );
      }

      // No status means the downstream never answered — a timeout, a dead
      // process, a transport failure. That is 503, not 500: the gateway is
      // fine and a retry may well succeed, which is precisely what a 500 tells
      // a caller *not* to assume. A downstream's own errors always carry a
      // status, because it maps them itself.
      //
      // The detail is deliberately generic. A downstream stack trace must not
      // reach a client.
      throw new ServiceUnavailableException(
        `${service} is not responding. Please retry in a few seconds.`,
      );
    }
  }
}
