import { HttpException, InternalServerErrorException } from '@nestjs/common';
import { Observable, firstValueFrom, timeout } from 'rxjs';

/** Downstream services are local; anything slower than this is a fault. */
export const RPC_TIMEOUT_MS = 5000;

interface RpcErrorShape {
  status?: number;
  message?: string;
}

/**
 * Awaits an RPC call and translates downstream failures into HTTP responses.
 *
 * Without this, an `RpcException` carrying `{status: 401}` surfaces as a 500:
 * the gateway sees an unrecognised error object and falls back. That turns
 * "wrong password" into "our server is broken", which is both wrong and
 * unactionable for the caller.
 *
 * Unrecognised errors deliberately become a generic 500 — a downstream stack
 * trace must not be forwarded to a client.
 */
export async function rpc<T>(source: Observable<T>): Promise<T> {
  try {
    return await firstValueFrom(source.pipe(timeout(RPC_TIMEOUT_MS)));
  } catch (error) {
    const shape = error as RpcErrorShape;

    if (typeof shape?.status === 'number' && shape.status >= 400) {
      throw new HttpException(shape.message ?? 'Request failed', shape.status);
    }

    throw new InternalServerErrorException();
  }
}
