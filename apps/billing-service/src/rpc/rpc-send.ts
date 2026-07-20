import { RpcException } from '@nestjs/microservices';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

const RPC_TIMEOUT_MS = 5000;

/**
 * Sends an RPC and preserves the downstream error's status.
 *
 * Without this, a 404 from contracts-service arrives at the gateway as an
 * unrecognised object and becomes a 500 — turning "that milestone does not
 * exist" into "our server is broken". The timeout matters for the same reason
 * it does at the gateway: an unreachable service must fail, not hang.
 */
export async function rpcSend<T>(
  client: ClientProxy,
  pattern: string,
  payload: unknown,
): Promise<T> {
  try {
    return await firstValueFrom(
      client.send<T>(pattern, payload).pipe(timeout(RPC_TIMEOUT_MS)),
    );
  } catch (error) {
    const shape = error as { status?: number; message?: string };

    if (typeof shape?.status === 'number') {
      throw new RpcException({
        status: shape.status,
        message: shape.message ?? 'Downstream request failed',
      });
    }

    throw error;
  }
}
