import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { Enveloped } from './message-envelope.dto';
import { PaginationQueryDto } from './pagination.dto';

/** Mirrors `InvoiceStatus` in the Prisma schema. */
export enum InvoiceStatusDto {
  PENDING = 'PENDING',
  ISSUED = 'ISSUED',
  GENERATION_FAILED = 'GENERATION_FAILED',
  PAID = 'PAID',
}

/**
 * An invoice is created *from a completed milestone* — that is the only input.
 *
 * Amounts are not accepted from the client. Letting a caller supply the total
 * would make the invoice a claim rather than a derivation, and the whole point
 * of the command handler is that the figure comes from the milestone and the
 * tenant's tax rate.
 */
export class CreateInvoiceDto {
  @IsUUID()
  milestoneId!: string;
}

export class ListInvoicesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(InvoiceStatusDto)
  status?: InvoiceStatusDto;

  @IsOptional()
  @IsUUID()
  contractId?: string;
}

export interface InvoiceDto {
  id: string;
  tenantId: string;
  contractId: string;
  clientId: string;
  milestoneId: string;
  /** Money as strings — JSON numbers are IEEE 754 doubles. */
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
  currency: string;
  status: InvoiceStatusDto;
  pdfUrl: string | null;
  failureReason: string | null;
  generationAttempts: number;
  issuedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What contracts-service returns for `GET_MILESTONE_FOR_BILLING`. */
export interface MilestoneForBillingDto {
  id: string;
  contractId: string;
  clientId: string;
  title: string;
  amount: string;
  currency: string;
  status: string;
  contractStatus: string;
}

/** What tenants-service returns for `GET_TENANT`. */
export interface TenantDto {
  id: string;
  name: string;
  country: string;
}

/** Payload for the worker's PDF request. */
export interface GeneratePdfRequest {
  correlationId: string;
  tenantId: string;
  invoiceId: string;
}

export interface GeneratePdfResult {
  pdfUrl: string;
}

export type CreateInvoiceRpcRequest = Enveloped<CreateInvoiceDto> & {
  tenantId: string;
};

export type GetInvoiceRpcRequest = Enveloped<{ invoiceId: string }> & {
  tenantId: string;
};

export type ListInvoicesRpcRequest = Enveloped<ListInvoicesQueryDto> & {
  tenantId: string;
};
