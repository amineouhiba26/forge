import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
  PaymentIntentDto,
} from '@forge/contracts';

import { RequirePermission } from '../auth/casl/require-permission.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { CorrelationId } from '../common/correlation-id.decorator';
import { RpcService } from '../common/rpc.service';
import { BILLING_CLIENT } from '../rpc/rpc-clients.module';

@Controller('invoices')
export class InvoicesController {
  constructor(
    @Inject(BILLING_CLIENT) private readonly billing: ClientProxy,
    private readonly rpc: RpcService,
  ) {}

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
    return this.rpc.send(
      'billing-service',
      this.billing.send(BILLING_PATTERNS.CREATE_INVOICE, {
        ...body,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }

  /**
   * Starts collection for an issued invoice.
   *
   * `issue Invoice` rather than `read`: asking a client for money is the same
   * privilege as billing them in the first place.
   */
  @Post(':id/payment-intent')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('issue', 'Invoice')
  createPaymentIntent(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CorrelationId() correlationId: string,
  ): Promise<PaymentIntentDto> {
    return this.rpc.send(
      'billing-service',
      this.billing.send(BILLING_PATTERNS.CREATE_PAYMENT_INTENT, {
        invoiceId: id,
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
    return this.rpc.send(
      'billing-service',
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
    return this.rpc.send(
      'billing-service',
      this.billing.send(BILLING_PATTERNS.GET_INVOICE, {
        invoiceId: id,
        tenantId: user.tenantId,
        correlationId,
      }),
    );
  }
}
