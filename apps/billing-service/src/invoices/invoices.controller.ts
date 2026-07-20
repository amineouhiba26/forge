import { Controller } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { BILLING_PATTERNS } from '@forge/contracts';
import type {
  CreateInvoiceRpcRequest,
  GetInvoiceRpcRequest,
  InvoiceDto,
  ListInvoicesRpcRequest,
  PaginatedResult,
} from '@forge/contracts';

import { CreateInvoiceCommand } from './commands/create-invoice.command';
import { GetInvoiceQuery, ListInvoicesQuery } from './queries/invoice.queries';

/**
 * The transport edge of billing-service.
 *
 * It does no work: it translates a message into a command or a query and hands
 * it to the appropriate bus. Business rules living here instead would be
 * unreachable from anything but an RPC call — including from the saga.
 */
@Controller()
export class InvoicesController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @MessagePattern(BILLING_PATTERNS.CREATE_INVOICE)
  create(
    @Payload() payload: CreateInvoiceRpcRequest,
  ): Promise<{ invoiceId: string }> {
    // Writes go through the command bus...
    return this.commandBus.execute(
      new CreateInvoiceCommand(
        payload.tenantId,
        payload.milestoneId,
        payload.correlationId,
      ),
    );
  }

  @MessagePattern(BILLING_PATTERNS.GET_INVOICE)
  get(@Payload() payload: GetInvoiceRpcRequest): Promise<InvoiceDto> {
    // ...and reads through the query bus. Same service, separate paths.
    return this.queryBus.execute(
      new GetInvoiceQuery(payload.tenantId, payload.invoiceId),
    );
  }

  @MessagePattern(BILLING_PATTERNS.LIST_INVOICES)
  list(
    @Payload() payload: ListInvoicesRpcRequest,
  ): Promise<PaginatedResult<InvoiceDto>> {
    return this.queryBus.execute(
      new ListInvoicesQuery(payload.tenantId, payload),
    );
  }
}
