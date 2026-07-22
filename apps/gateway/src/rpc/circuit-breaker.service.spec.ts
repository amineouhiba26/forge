import { ServiceUnavailableException } from '@nestjs/common';

import { CircuitBreakerService } from './circuit-breaker.service';

/** Fails immediately with a status, as a downstream 4xx would. */
const clientError = (status: number) => () =>
  Promise.reject(Object.assign(new Error('rejected'), { status }));

/** Fails with no status, as an unreachable service does. */
const transportFailure = () => () =>
  Promise.reject(new Error('Timeout has occurred'));

describe('CircuitBreakerService', () => {
  let breakers: CircuitBreakerService;

  beforeEach(() => {
    breakers = new CircuitBreakerService();
  });

  /** Drives enough failures to cross the volume threshold. */
  async function failNTimes(
    service: string,
    n: number,
    work: () => () => Promise<unknown>,
  ) {
    for (let i = 0; i < n; i += 1) {
      await breakers.execute(service, work()).catch(() => undefined);
    }
  }

  it('passes a successful call through untouched', async () => {
    await expect(
      breakers.execute('billing-service', () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
  });

  it('starts closed and reports state per service', () => {
    expect(breakers.stateOf('billing-service')).toBe('unused');
  });

  it('keeps one breaker per downstream, so one outage is not total', async () => {
    await failNTimes('billing-service', 5, transportFailure);

    expect(breakers.stateOf('billing-service')).toBe('open');
    // tenants-service was never called and must be unaffected — a shared
    // breaker would take the whole gateway down with one dependency.
    expect(breakers.stateOf('tenants-service')).toBe('unused');
    await expect(
      breakers.execute('tenants-service', () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
  });

  describe('opening', () => {
    it('opens after repeated transport failures', async () => {
      await failNTimes('billing-service', 5, transportFailure);

      expect(breakers.stateOf('billing-service')).toBe('open');
    });

    it('fails fast with a 503 once open, without attempting the call', async () => {
      await failNTimes('billing-service', 5, transportFailure);

      const work = jest.fn(() => Promise.resolve('ok'));
      await expect(
        breakers.execute('billing-service', work),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // The point of an open circuit: the doomed call is never made.
      expect(work).not.toHaveBeenCalled();
    });

    it('names the service in the error, so the message is actionable', async () => {
      await failNTimes('billing-service', 5, transportFailure);

      const error = await breakers
        .execute('billing-service', () => Promise.resolve('ok'))
        .catch((e: Error) => e);

      expect((error as Error).message).toContain('billing-service');
    });
  });

  describe('what does not open it', () => {
    it('ignores downstream 4xx responses', async () => {
      // "Not found" and "forbidden" are the service working correctly.
      // Counting them would let a client bug take a healthy service offline.
      await failNTimes('billing-service', 10, () => clientError(404));
      await failNTimes('billing-service', 10, () => clientError(403));

      expect(breakers.stateOf('billing-service')).toBe('closed');
    });

    it('still opens on 500, which is the service saying it is broken', async () => {
      await failNTimes('billing-service', 6, () => clientError(500));

      expect(breakers.stateOf('billing-service')).toBe('open');
    });

    it('ignores 502 — the service is alive, its own upstream failed', async () => {
      // billing returns 502 when Stripe rejects us. Counting it would open
      // billing's circuit and take invoice listing and reading offline for
      // every tenant because of a payment-provider problem on one route,
      // escalating a localised fault into a service-wide outage.
      await failNTimes('billing-service', 10, () => clientError(502));

      expect(breakers.stateOf('billing-service')).toBe('closed');
    });

    it('does not open below the volume threshold', async () => {
      // A single blip must not become an outage — without a volume threshold
      // one failure is a 100% failure rate.
      await failNTimes('billing-service', 2, transportFailure);

      expect(breakers.stateOf('billing-service')).toBe('closed');
    });
  });

  describe('recovery', () => {
    it('probes once after the cooldown and closes when the probe succeeds', async () => {
      jest.useFakeTimers();

      try {
        await failNTimes('billing-service', 5, transportFailure);
        expect(breakers.stateOf('billing-service')).toBe('open');

        // Past the 10s resetTimeout.
        jest.advanceTimersByTime(11_000);
        expect(breakers.stateOf('billing-service')).toBe('half-open');

        jest.useRealTimers();
        await breakers.execute('billing-service', () => Promise.resolve('ok'));

        // A breaker that opens but never closes is an outage the dependency
        // already recovered from.
        expect(breakers.stateOf('billing-service')).toBe('closed');
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
