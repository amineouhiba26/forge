import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { RpcException } from '@nestjs/microservices';

import {
  InvoiceDto,
  InvoiceStatusDto,
  PaginatedResult,
  buildPaginatedResult,
  toSkipTake,
} from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

import { GetInvoiceQuery, ListInvoicesQuery } from './invoice.queries';

@QueryHandler(GetInvoiceQuery)
export class GetInvoiceHandler implements IQueryHandler<GetInvoiceQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetInvoiceQuery): Promise<InvoiceDto> {
    const invoice = await this.prisma.forTenant(query.tenantId, (tx) =>
      tx.invoice.findUnique({ where: { id: query.invoiceId } }),
    );

    // Another tenant's invoice is invisible to RLS, so "not yours" and "does
    // not exist" are the same answer — deliberately.
    if (!invoice) {
      throw new RpcException({ status: 404, message: 'Invoice not found' });
    }

    return toInvoiceDto(invoice);
  }
}

@QueryHandler(ListInvoicesQuery)
export class ListInvoicesHandler implements IQueryHandler<ListInvoicesQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    query: ListInvoicesQuery,
  ): Promise<PaginatedResult<InvoiceDto>> {
    const { skip, take } = toSkipTake(query.filters);

    const where = {
      ...(query.filters.status ? { status: query.filters.status } : {}),
      ...(query.filters.contractId
        ? { contractId: query.filters.contractId }
        : {}),
    };

    const [invoices, total] = await this.prisma.forTenant(
      query.tenantId,
      async (tx) =>
        Promise.all([
          tx.invoice.findMany({
            where,
            skip,
            take,
            orderBy: { createdAt: 'desc' },
          }),
          tx.invoice.count({ where }),
        ]),
    );

    return buildPaginatedResult(
      invoices.map(toInvoiceDto),
      total,
      query.filters,
    );
  }
}

interface InvoiceRow {
  id: string;
  tenantId: string;
  contractId: string;
  clientId: string;
  milestoneId: string;
  subtotal: { toFixed(dp: number): string };
  taxRate: { toFixed(dp: number): string };
  taxAmount: { toFixed(dp: number): string };
  total: { toFixed(dp: number): string };
  currency: string;
  status: string;
  pdfUrl: string | null;
  failureReason: string | null;
  generationAttempts: number;
  issuedAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toInvoiceDto(invoice: InvoiceRow): InvoiceDto {
  return {
    id: invoice.id,
    tenantId: invoice.tenantId,
    contractId: invoice.contractId,
    clientId: invoice.clientId,
    milestoneId: invoice.milestoneId,
    // Money as strings with their minor units — see the Decimal note in the
    // schema. A JSON number would be an IEEE 754 double.
    subtotal: invoice.subtotal.toFixed(2),
    taxRate: invoice.taxRate.toFixed(2),
    taxAmount: invoice.taxAmount.toFixed(2),
    total: invoice.total.toFixed(2),
    currency: invoice.currency,
    status: invoice.status as InvoiceStatusDto,
    pdfUrl: invoice.pdfUrl,
    failureReason: invoice.failureReason,
    generationAttempts: invoice.generationAttempts,
    issuedAt: invoice.issuedAt?.toISOString() ?? null,
    paidAt: invoice.paidAt?.toISOString() ?? null,
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
  };
}
