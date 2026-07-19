/**
 * RPC message patterns. Every request/response call between the gateway and a
 * downstream service must reference a constant from here — never a string
 * literal at the call site. This file is the single source of truth that the
 * contract tests in Sprint 7 will assert against.
 *
 * Naming convention: `<service>.<resource>.<action>`
 */

export const TENANTS_PATTERNS = {
  PING: 'tenants.health.ping',
} as const;

export const CONTRACTS_PATTERNS = {
  PING: 'contracts.health.ping',
} as const;

export const BILLING_PATTERNS = {
  PING: 'billing.health.ping',
} as const;

export const WORKER_PATTERNS = {
  PING: 'worker.health.ping',
} as const;
