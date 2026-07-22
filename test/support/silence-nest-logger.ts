import { Logger } from '@nestjs/common';

/**
 * Silences Nest's logger for the unit suite.
 *
 * Several unit tests deliberately drive failure paths — a circuit breaker
 * opening, a saga that cannot find its invoice — and the code under test logs
 * those at WARN and ERROR, correctly. Printed during a passing run they are
 * misleading: red text in the output of a green suite teaches people to stop
 * reading it, which is exactly when a real error gets missed.
 *
 * Stubbed on the prototype rather than via `Logger.overrideLogger()`. The
 * static override does not reach a class holding its own
 * `private readonly logger = new Logger(Name)` — that instance carries its own
 * levels, which is why one ERROR line survived the first attempt.
 *
 * These are `jest.spyOn` mocks, so a test that wants to assert something was
 * logged still can.
 */
const SILENCED = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;

beforeEach(() => {
  for (const method of SILENCED) {
    if (typeof Logger.prototype[method] === 'function') {
      jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined);
    }
  }
});
