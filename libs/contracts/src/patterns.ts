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

  /** Dispatches CreateInvoiceCommand. */
  CREATE_INVOICE: 'billing.invoices.create',
  GET_INVOICE: 'billing.invoices.get',
  LIST_INVOICES: 'billing.invoices.list',
} as const;

export const WORKER_PATTERNS = {
  PING: 'worker.health.ping',

  /**
   * Renders an invoice PDF. Sprint 3 answers synchronously so the saga can
   * observe failure and compensate; Sprint 5 replaces it with a BullMQ job.
   */
  GENERATE_INVOICE_PDF: 'worker.pdf.generateInvoice',
} as const;
