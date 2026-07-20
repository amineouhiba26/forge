import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { ClientProxy, RpcException } from '@nestjs/microservices';

import { CONTRACTS_PATTERNS, TENANTS_PATTERNS } from '@forge/contracts';
import type { MilestoneForBillingDto, TenantDto } from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

import { CONTRACTS_CLIENT, TENANTS_CLIENT } from '../../rpc/rpc-clients.module';
import { rpcSend } from '../../rpc/rpc-send';
import { TaxService, calculateTax } from '../../tax/tax.service';
import { InvoiceCreatedEvent } from '../events/invoice.events';
import { CreateInvoiceCommand } from './create-invoice.command';

@CommandHandler(CreateInvoiceCommand)
export class CreateInvoiceHandler implements ICommandHandler<CreateInvoiceCommand> {
  private readonly logger = new Logger(CreateInvoiceHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tax: TaxService,
    private readonly eventBus: EventBus,
    @Inject(CONTRACTS_CLIENT) private readonly contracts: ClientProxy,
    @Inject(TENANTS_CLIENT) private readonly tenants: ClientProxy,
  ) {}

  async execute(command: CreateInvoiceCommand): Promise<{ invoiceId: string }> {
    const { tenantId, milestoneId, correlationId } = command;

    // 1. Fetch the milestone from the service that owns it. Billing does not
    //    read the contracts tables directly — they belong to another service,
    //    and sharing a schema across services means neither can change it.
    const milestone = await rpcSend<MilestoneForBillingDto>(
      this.contracts,
      CONTRACTS_PATTERNS.GET_MILESTONE_FOR_BILLING,
      { tenantId, milestoneId, correlationId },
    );

    // 2. Refuse to invoice work that is not done. This is the rule the backlog
    //    names, and it belongs here rather than at the gateway: it is a
    //    business invariant, not input validation.
    if (milestone.status !== 'COMPLETE') {
      throw new RpcException({
        status: 409,
        message: 'Cannot invoice a milestone that is not complete',
      });
    }

    if (milestone.contractStatus === 'CANCELLED') {
      throw new RpcException({
        status: 409,
        message: 'Cannot invoice a milestone on a cancelled contract',
      });
    }

    // 3. Resolve the tax rate from the tenant's country.
    const tenant = await rpcSend<TenantDto>(
      this.tenants,
      TENANTS_PATTERNS.GET_TENANT,
      { tenantId, correlationId },
    );

    const subtotal = Number(milestone.amount);
    const taxRate = this.tax.rateForCountry(tenant.country);
    const { taxAmount, total } = calculateTax(subtotal, taxRate);

    // 4. Create the invoice as PENDING. The PDF does not exist yet, and
    //    pretending otherwise would make the status a lie.
    //
    // Typed explicitly because it is assigned inside the try block: an
    // untyped `let` would be `any`, and every later read of it unchecked.
    let invoice: CreatedInvoice;
    try {
      invoice = await this.prisma.forTenant(tenantId, (tx) =>
        tx.invoice.create({
          data: {
            tenantId,
            contractId: milestone.contractId,
            clientId: milestone.clientId,
            milestoneId,
            subtotal,
            taxRate,
            taxAmount,
            total,
            currency: milestone.currency,
            status: 'PENDING',
          },
        }),
      );
    } catch (error) {
      // The unique constraint on milestone_id is what actually prevents
      // double-invoicing. An application-level "already invoiced?" check
      // cannot: two concurrent commands would both read "no" before either
      // wrote. The database is the only place this can be decided.
      if (isUniqueViolation(error)) {
        throw new RpcException({
          status: 409,
          message: 'This milestone has already been invoiced',
        });
      }

      throw error;
    }

    this.logger.log(
      `Invoice ${invoice.id} created as PENDING (correlationId=${correlationId})`,
    );

    // 5. Announce it. The handler's job ends here — it does not know or care
    //    that a saga is about to request a PDF. That decoupling is the reason
    //    this is not one long createInvoice() method: adding a notification or
    //    a ledger entry later means adding a subscriber, not editing this.
    this.eventBus.publish(
      new InvoiceCreatedEvent(
        tenantId,
        invoice.id,
        milestoneId,
        invoice.total.toFixed(2),
        invoice.currency,
        correlationId,
      ),
    );

    return { invoiceId: invoice.id };
  }
}

/** The fields of the created row this handler actually reads. */
interface CreatedInvoice {
  id: string;
  total: { toFixed(decimalPlaces: number): string };
  currency: string;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}
