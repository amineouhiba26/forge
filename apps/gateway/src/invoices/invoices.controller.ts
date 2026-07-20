import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import {
  BILLING_PATTERNS,
  CreateInvoiceDto,
  ListInvoicesQueryDto,
} from '@forge/contracts';
import type {
  AuthenticatedUser,
  InvoiceDto,
  PaginatedResult,
} from '@forge/contracts';

import { RequirePermission } from '../auth/casl/require-permission.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { CorrelationId } from '../common/correlation-id.decorator';
import { rpc } from '../common/rpc';
import { BILLING_CLIENT } from '../rpc/rpc-clients.module';

@Controller('invoices')
export class InvoicesController {
  constructor(@Inject(BILLING_CLIENT) private readonly billing: ClientProxy) {}

  /**
   * Requires `issue Invoice`, not `create Invoice`.
   *
   * They are separate CASL actions because turning completed work into a
   * financial document is a distinct privilege — the backlog's example of a
   * member who can see contracts but cannot bill against them.
   */
  @Post()
  @RequirePermission('issue', 'Invoice')
  create(
    @Body() body: CreateInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<{ invoiceId: string }> {
    return rpc(
      this.billing.send(BILLING_PATTERNS.CREATE_INVOICE, {
        ...body,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  @Get()
  @RequirePermission('read', 'Invoice')
  list(
    @Query() query: ListInvoicesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<PaginatedResult<InvoiceDto>> {
    return rpc(
      this.billing.send(BILLING_PATTERNS.LIST_INVOICES, {
        ...query,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  @Get(':id')
  @RequirePermission('read', 'Invoice')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<InvoiceDto> {
    return rpc(
      this.billing.send(BILLING_PATTERNS.GET_INVOICE, {
        invoiceId: id,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }
}
