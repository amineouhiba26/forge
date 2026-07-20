import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import CircuitBreaker from 'opossum';

/**
 * Per-downstream circuit breakers for the gateway's RPC calls.
 *
 * **opossum rather than hand-rolled**, which the backlog asks to be decided and
 * justified. A breaker is not an `if` around a failure counter: it needs a
 * rolling window (so old failures age out), a volume threshold (so the first
 * failed request of the day does not trip it), a half-open state, and exactly
 * one probe request while half-open. Getting any of those wrong produces a
 * breaker that either never opens or never closes — and a breaker that never
 * closes is an outage the dependency already recovered from.
 *
 * The state machine:
 *
 * ```
 *   CLOSED ──(≥50% of ≥5 requests fail in 10s)──► OPEN
 *      ▲                                            │
 *      │                                     (10s cooldown)
 *      │                                            ▼
 *      └────────(probe succeeds)──── HALF-OPEN ─────┘
 *                                        │
 *                                 (probe fails) ──► OPEN
 * ```
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly breakers = new Map<
    string,
    CircuitBreaker<[() => Promise<unknown>], unknown>
  >();

  /**
   * Runs `work` behind the breaker for `service`.
   *
   * One breaker per downstream, not one globally: billing being down must not
   * stop the gateway talking to tenants. A shared breaker would turn one
   * service's outage into a total one.
   */
  async execute<T>(service: string, work: () => Promise<T>): Promise<T> {
    const breaker = this.breakerFor(service);

    try {
      return (await breaker.fire(work)) as T;
    } catch (error) {
      if (isBreakerOpen(error)) {
        // 503 with a Retry-After-shaped message, not a 500. The request did
        // not fail — it was never attempted, because the gateway already knows
        // this dependency is down. Saying so is the difference between "we are
        // broken" and "this part is unavailable, try shortly".
        throw new ServiceUnavailableException(
          `${service} is currently unavailable. Please retry in a few seconds.`,
        );
      }

      throw error;
    }
  }

  /** Current state, for the health endpoint to report. */
  stateOf(service: string): 'closed' | 'open' | 'half-open' | 'unused' {
    const breaker = this.breakers.get(service);

    if (!breaker) return 'unused';
    if (breaker.opened) return 'open';
    if (breaker.halfOpen) return 'half-open';
    return 'closed';
  }

  private breakerFor(
    service: string,
  ): CircuitBreaker<[() => Promise<unknown>], unknown> {
    const existing = this.breakers.get(service);
    if (existing) return existing;

    const breaker = new CircuitBreaker(
      (work: () => Promise<unknown>) => work(),
      {
        name: service,
        // Below the 5s RPC timeout used elsewhere: a breaker that waits as
        // long as the call it guards never sheds load.
        timeout: 3000,
        // Half of a rolling window must fail. Lower would trip on ordinary
        // 4xx-style failures; higher lets a mostly-dead service keep taking
        // requests.
        errorThresholdPercentage: 50,
        // How long to stay open before probing. Long enough for a restart to
        // finish, short enough that recovery is not perceived as an outage.
        resetTimeout: 10_000,
        // Without a volume threshold, one failure at 100% failure rate opens
        // the circuit — a single blip becomes an outage.
        //
        // The threshold and the window have to be sized *together*, against
        // how long a failing call takes. A failure here costs the full 3s
        // timeout, so a 10s window can only ever hold about three requests —
        // paired with a threshold of 5 the circuit could never open at all,
        // which is exactly what the first run of the demo showed. 30s of
        // window holds ~10 failing calls, comfortably above the threshold.
        volumeThreshold: 3,
        rollingCountTimeout: 30_000,
        rollingCountBuckets: 10,
        // A downstream *rejecting* a request is not a downstream *failure*.
        // "That invoice does not exist" and "you may not do that" are the
        // service working correctly, and counting them would take a healthy
        // service offline for being told about bad input — an easy way to
        // turn a client bug into an outage.
        errorFilter: (error: unknown) => isClientError(error),
      },
    );

    // Logged at warn, not error: an open circuit is the system working as
    // designed. The error was the failure that opened it.
    breaker.on('open', () =>
      this.logger.warn(
        `Circuit OPEN for ${service} — failing fast for 10s before probing`,
      ),
    );
    breaker.on('halfOpen', () =>
      this.logger.log(
        `Circuit HALF-OPEN for ${service} — probing with one request`,
      ),
    );
    breaker.on('close', () =>
      this.logger.log(`Circuit CLOSED for ${service} — recovered`),
    );

    this.breakers.set(service, breaker);
    return breaker;
  }
}

/** True for downstream 4xx responses, which must not count against the circuit. */
function isClientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function isBreakerOpen(error: unknown): boolean {
  // opossum signals a rejected-while-open call with this code.
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EOPENBREAKER'
  );
}
