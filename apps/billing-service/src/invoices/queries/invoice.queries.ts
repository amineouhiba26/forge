import { ListInvoicesQueryDto } from '@forge/contracts';

/**
 * Queries: read-only requests that never change state.
 *
 * Kept apart from commands rather than sharing one "invoice service" because
 * the two sides answer to different pressures. A command has to enforce
 * invariants — is the milestone complete, has it been invoiced already — and
 * runs once. A query has to be fast and can be served from a denormalised
 * read model without touching those rules at all.
 *
 * Sprint 3 reads both sides from the same tables, so the split buys nothing
 * *today*. It buys the ability to change one side later without touching the
 * other, which is the point: a read model added for reporting in a later
 * sprint would land here and leave the command path untouched.
 */
export class GetInvoiceQuery {
  constructor(
    public readonly tenantId: string,
    public readonly invoiceId: string,
  ) {}
}

export class ListInvoicesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filters: ListInvoicesQueryDto,
  ) {}
}
