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
  /**
   * Runs the service's own Terminus checks and reports them.
   *
   * A microservice has no HTTP surface, so it cannot expose `/health` for a
   * probe to scrape. It reports over the transport instead, and the gateway
   * aggregates — which also means a service that cannot answer *is* the
   * signal, with no separate liveness endpoint to keep in sync.
   */
  HEALTH: 'tenants.health.check',

  /** Creates a Tenant plus its first User (the owner). */
  SIGNUP: 'tenants.auth.signup',
  /** Exchanges credentials for an access/refresh token pair. */
  LOGIN: 'tenants.auth.login',
  /** Rotates a refresh token, returning a fresh pair. */
  REFRESH: 'tenants.auth.refresh',
  /** Revokes the presented refresh token. */
  LOGOUT: 'tenants.auth.logout',
  /** Reads the calling tenant itself — billing needs its country for tax. */
  GET_TENANT: 'tenants.tenants.get',
  /** Reads a user within the caller's tenant. */
  GET_USER: 'tenants.users.get',
  /** Lists users within the caller's tenant. */
  LIST_USERS: 'tenants.users.list',
} as const;

export const CONTRACTS_PATTERNS = {
  PING: 'contracts.health.ping',
  /**
   * Runs the service's own Terminus checks and reports them.
   *
   * A microservice has no HTTP surface, so it cannot expose `/health` for a
   * probe to scrape. It reports over the transport instead, and the gateway
   * aggregates — which also means a service that cannot answer *is* the
   * signal, with no separate liveness endpoint to keep in sync.
   */
  HEALTH: 'contracts.health.check',

  CREATE_CLIENT: 'contracts.clients.create',
  LIST_CLIENTS: 'contracts.clients.list',
  GET_CLIENT: 'contracts.clients.get',
  UPDATE_CLIENT: 'contracts.clients.update',
  ARCHIVE_CLIENT: 'contracts.clients.archive',

  CREATE_CONTRACT: 'contracts.contracts.create',
  LIST_CONTRACTS: 'contracts.contracts.list',
  GET_CONTRACT: 'contracts.contracts.get',
  UPDATE_CONTRACT: 'contracts.contracts.update',

  LIST_MILESTONES: 'contracts.milestones.list',
  COMPLETE_MILESTONE: 'contracts.milestones.complete',
  /**
   * Reads one milestone with the context billing needs to invoice it.
   * Billing does not query the contracts tables directly: they belong to
   * contracts-service, and reaching across would make the schema a shared
   * dependency that neither service could change safely.
   */
  GET_MILESTONE_FOR_BILLING: 'contracts.milestones.getForBilling',
} as const;

export const BILLING_PATTERNS = {
  PING: 'billing.health.ping',
  /**
   * Runs the service's own Terminus checks and reports them.
   *
   * A microservice has no HTTP surface, so it cannot expose `/health` for a
   * probe to scrape. It reports over the transport instead, and the gateway
   * aggregates — which also means a service that cannot answer *is* the
   * signal, with no separate liveness endpoint to keep in sync.
   */
  HEALTH: 'billing.health.check',

  /** Dispatches CreateInvoiceCommand. */
  CREATE_INVOICE: 'billing.invoices.create',
  GET_INVOICE: 'billing.invoices.get',
  LIST_INVOICES: 'billing.invoices.list',

  /** Creates a Stripe PaymentIntent for an issued invoice. */
  CREATE_PAYMENT_INTENT: 'billing.payments.createIntent',
  /**
   * Handles a raw Stripe webhook. The gateway forwards the untouched body and
   * signature header; billing-service verifies and interprets them, so no
   * Stripe secret has to live outside the service that owns payments.
   */
  HANDLE_STRIPE_WEBHOOK: 'billing.payments.handleWebhook',
} as const;

export const WORKER_PATTERNS = {
  PING: 'worker.health.ping',
  /**
   * Runs the service's own Terminus checks and reports them.
   *
   * A microservice has no HTTP surface, so it cannot expose `/health` for a
   * probe to scrape. It reports over the transport instead, and the gateway
   * aggregates — which also means a service that cannot answer *is* the
   * signal, with no separate liveness endpoint to keep in sync.
   */
  HEALTH: 'worker.health.check',
  // Sprint 3's synchronous `worker.pdf.generateInvoice` is gone. PDF work is
  // a durable BullMQ job as of Sprint 5 — see `queues.ts`. The pattern was
  // removed rather than left in place, because a dead message pattern reads
  // as a live one.
} as const;
