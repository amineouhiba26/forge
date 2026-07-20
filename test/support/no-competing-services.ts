import { ClientProxy, ClientProxyFactory } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

import { TENANTS_PATTERNS, buildRedisTransportOptions } from '@forge/contracts';

/**
 * Refuses to start an e2e suite while another copy of the services is running.
 *
 * The e2e suites boot their own microservices against the shared Redis. If a
 * manually-started stack is also running — `node dist/apps/...` left over from
 * poking at something — every RPC pattern and every BullMQ queue has two
 * subscribers, and each request is answered by whichever wins the race.
 *
 * The failures that produces are nondeterministic and misleading: a 404 for an
 * invoice that plainly exists, a socket hang up, a job that succeeded when the
 * test had rigged it to fail. Nothing points at the real cause, and re-running
 * often passes — which invites the conclusion that the *application* is flaky.
 *
 * This turns that into an immediate failure that names the problem. It cost a
 * sprint of "unresolved flake" to learn, so it is worth the two seconds.
 */
export async function assertNoCompetingServices(): Promise<void> {
  const client: ClientProxy = ClientProxyFactory.create(
    buildRedisTransportOptions(),
  );

  try {
    await client.connect();

    // Any service would do; tenants-service is the one every suite starts.
    const reply = await firstValueFrom(
      client
        .send<unknown>(TENANTS_PATTERNS.PING, {
          correlationId: '00000000-0000-4000-8000-000000000000',
          from: 'e2e-preflight',
        })
        // Short: nothing should answer, so this is the expected path and the
        // suite should not pay for it.
        .pipe(timeout(1500)),
    );

    throw new CompetingServicesError(reply);
  } catch (error) {
    if (error instanceof CompetingServicesError) throw error;
    // A timeout is success: nobody answered, so no other stack is listening.
  } finally {
    await client.close();
  }
}

class CompetingServicesError extends Error {
  constructor(reply: unknown) {
    super(
      'Another instance of the services is already running against this Redis.\n' +
        `A ping was answered by: ${JSON.stringify(reply)}\n\n` +
        'Two subscribers per pattern means requests are answered by whichever\n' +
        'wins the race, and queued jobs are consumed by either worker — which\n' +
        'produces misleading, nondeterministic failures.\n\n' +
        'Stop the other stack first:\n' +
        '  pkill -f "dist/apps"',
    );
    this.name = 'CompetingServicesError';
  }
}
