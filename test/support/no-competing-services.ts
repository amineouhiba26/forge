import { ClientProxy, ClientProxyFactory } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

import {
  BILLING_PATTERNS,
  CONTRACTS_PATTERNS,
  TENANTS_PATTERNS,
  WORKER_PATTERNS,
  buildRedisTransportOptions,
} from '@forge/contracts';

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
/**
 * Every service is probed, not just one.
 *
 * The first version pinged only tenants-service, on the assumption that a
 * stray stack means *all* of it is running. That is not true — a partially
 * started or partially stopped stack leaves some services subscribed and
 * others not, and a lingering contracts-service passed the check while still
 * answering RPCs.
 */
const PROBES: Array<[string, string]> = [
  ['tenants-service', TENANTS_PATTERNS.PING],
  ['contracts-service', CONTRACTS_PATTERNS.PING],
  ['billing-service', BILLING_PATTERNS.PING],
  ['worker-service', WORKER_PATTERNS.PING],
];

export async function assertNoCompetingServices(): Promise<void> {
  const client: ClientProxy = ClientProxyFactory.create(
    buildRedisTransportOptions(),
  );

  try {
    await client.connect();

    const responders = await Promise.all(
      PROBES.map(async ([name, pattern]) => {
        try {
          await firstValueFrom(
            client
              .send<unknown>(pattern, {
                correlationId: '00000000-0000-4000-8000-000000000000',
                from: 'e2e-preflight',
              })
              // Short: nothing should answer, so this is the expected path and
              // the suite should not pay for it.
              .pipe(timeout(1500)),
          );
          return name;
        } catch {
          // A timeout is success — nobody is listening on that pattern.
          return undefined;
        }
      }),
    );

    const running = responders.filter((name): name is string => Boolean(name));

    if (running.length > 0) {
      throw new CompetingServicesError(running);
    }
  } finally {
    await client.close();
  }
}

class CompetingServicesError extends Error {
  constructor(running: string[]) {
    super(
      'Another instance of the services is already running against this Redis.\n' +
        `Answered a ping: ${running.join(', ')}\n\n` +
        'Two subscribers per pattern means requests are answered by whichever\n' +
        'wins the race, and queued jobs are consumed by either worker — which\n' +
        'produces misleading, nondeterministic failures.\n\n' +
        'Stop the other stack first:\n' +
        '  pkill -f "dist/apps"',
    );
    this.name = 'CompetingServicesError';
  }
}
