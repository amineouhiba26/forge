import 'dotenv/config';

import { PATTERN_METADATA } from '@nestjs/microservices/constants';

import {
  BILLING_PATTERNS,
  CONTRACTS_PATTERNS,
  EVENTS,
  TENANTS_PATTERNS,
  WORKER_PATTERNS,
} from '@forge/contracts';

// Message-handling controllers, by the service that owns them.
import { InvoicesController } from '../apps/billing-service/src/invoices/invoices.controller';
import { PaymentsController } from '../apps/billing-service/src/payments/payments.controller';
import { HealthController as BillingHealth } from '../apps/billing-service/src/health.controller';
import { WorkerEventsController } from '../apps/billing-service/src/invoices/worker-events.controller';
import { ClientsController } from '../apps/contracts-service/src/clients/clients.controller';
import { ContractsController } from '../apps/contracts-service/src/contracts/contracts.controller';
import { HealthController as ContractsHealth } from '../apps/contracts-service/src/health.controller';
import { AuthController } from '../apps/tenants-service/src/auth/auth.controller';
import { HealthController as TenantsHealth } from '../apps/tenants-service/src/health.controller';
import { UsersController } from '../apps/tenants-service/src/users/users.controller';
import { HealthController as WorkerHealth } from '../apps/worker-service/src/health.controller';

/**
 * Contract tests between the gateway and every downstream service.
 *
 * `libs/contracts` is the source of truth: it declares every message pattern
 * and event name, and both sides import from it. These tests check that the
 * declaration and the implementations have not drifted apart.
 *
 * **Why this cannot be caught by the compiler.** A `@MessagePattern` takes a
 * string. If a constant is renamed, both sides still compile — the producer
 * sends `contracts.clients.list` and the consumer subscribes to
 * `contracts.clients.listAll`, and the only symptom is that requests time out
 * at runtime. Sprint 0's `as const` narrows the *type* of the value, not
 * whether anyone listens to it.
 *
 * These read metadata rather than sending messages: the question is whether a
 * handler is registered for every declared pattern, which is answerable
 * without a network. It also means a missing handler fails in milliseconds
 * with a clear message instead of as a five-second timeout somewhere else.
 */
describe('Contracts between services (e2e)', () => {
  /** Reads the pattern each `@MessagePattern`/`@EventPattern` method declares. */
  function patternsHandledBy(controller: new (...args: never[]) => object) {
    const prototype = controller.prototype as object;

    return Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .flatMap((name) => {
        const handler = (prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') return [];

        const pattern: unknown = Reflect.getMetadata(PATTERN_METADATA, handler);
        if (!pattern) return [];

        // Nest stores the pattern as an array even for a single one.
        return (Array.isArray(pattern) ? pattern : [pattern]).map(String);
      });
  }

  const handlers = {
    'tenants-service': [TenantsHealth, AuthController, UsersController],
    'contracts-service': [
      ContractsHealth,
      ClientsController,
      ContractsController,
    ],
    'billing-service': [
      BillingHealth,
      InvoicesController,
      PaymentsController,
      WorkerEventsController,
    ],
    'worker-service': [WorkerHealth],
  } as const;

  const declared = {
    'tenants-service': Object.values(TENANTS_PATTERNS),
    'contracts-service': Object.values(CONTRACTS_PATTERNS),
    'billing-service': Object.values(BILLING_PATTERNS),
    'worker-service': Object.values(WORKER_PATTERNS),
  } as const;

  function handledBy(service: keyof typeof handlers): string[] {
    return handlers[service].flatMap((controller) =>
      patternsHandledBy(controller as never),
    );
  }

  describe('every declared pattern has a handler', () => {
    // The failure this catches: a pattern is renamed in libs/contracts, the
    // producer picks up the new value, and the consumer is never updated.
    // Both compile; requests time out in production.
    it.each(Object.keys(handlers) as (keyof typeof handlers)[])(
      '%s implements every pattern it declares',
      (service) => {
        const implemented = new Set(handledBy(service));
        const missing = declared[service].filter(
          (pattern) => !implemented.has(pattern),
        );

        expect(missing).toEqual([]);
      },
    );
  });

  describe('no handler listens on an undeclared pattern', () => {
    // The reverse failure: a handler hardcodes a string literal instead of
    // importing the constant, so renaming the constant silently orphans it.
    const eventNames = new Set<string>(Object.values(EVENTS));

    it.each(Object.keys(handlers) as (keyof typeof handlers)[])(
      '%s only handles patterns from libs/contracts',
      (service) => {
        const declaredHere = new Set<string>(declared[service]);

        const undeclared = handledBy(service).filter(
          (pattern) => !declaredHere.has(pattern) && !eventNames.has(pattern),
        );

        expect(undeclared).toEqual([]);
      },
    );
  });

  describe('no pattern is handled twice', () => {
    it.each(Object.keys(handlers) as (keyof typeof handlers)[])(
      '%s registers each pattern exactly once',
      (service) => {
        const seen = handledBy(service);
        const duplicates = seen.filter(
          (pattern, index) => seen.indexOf(pattern) !== index,
        );

        // Two handlers on one pattern means both reply and the caller takes
        // whichever is faster — the same nondeterminism that made the Sprint 5
        // flake so hard to read.
        expect(duplicates).toEqual([]);
      },
    );
  });

  describe('pattern names stay unique across services', () => {
    it('no two services claim the same pattern', () => {
      const all = Object.keys(handlers).flatMap((service) =>
        handledBy(service as keyof typeof handlers),
      );
      const duplicates = all.filter(
        (pattern, index) => all.indexOf(pattern) !== index,
      );

      // Everything shares one Redis, so a collision means both services
      // receive the message.
      expect(duplicates).toEqual([]);
    });

    it('every pattern is namespaced by its service', () => {
      // The `<service>.<resource>.<action>` convention from Sprint 0 is what
      // makes collisions unlikely in the first place.
      for (const [service, patterns] of Object.entries(declared)) {
        const prefix = service.replace('-service', '');

        for (const pattern of patterns) {
          expect(pattern.startsWith(`${prefix}.`)).toBe(true);
        }
      }
    });
  });

  describe('events the worker emits are handled by billing', () => {
    it('billing subscribes to every worker outcome event', () => {
      const billingHandles = new Set(handledBy('billing-service'));

      // The Sprint 5 rework made these the *only* way billing learns a job
      // finished. An unsubscribed event leaves invoices stuck in PENDING with
      // nothing watching, which is exactly the failure mode the queue was
      // meant to remove.
      expect(billingHandles.has(EVENTS.INVOICE_PDF_GENERATED)).toBe(true);
      expect(billingHandles.has(EVENTS.INVOICE_PDF_FAILED)).toBe(true);
      expect(billingHandles.has(EVENTS.INVOICE_EMAIL_SENT)).toBe(true);
    });
  });
});
