import { Test } from '@nestjs/testing';
import { EventBus } from '@nestjs/cqrs';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';

import { PrismaService, TenantScopedClient } from '@forge/prisma';

import { CONTRACTS_CLIENT, TENANTS_CLIENT } from '../../rpc/rpc-clients.module';
import { TaxService } from '../../tax/tax.service';
import { InvoiceCreatedEvent } from '../events/invoice.events';
import { CreateInvoiceCommand } from './create-invoice.command';
import { CreateInvoiceHandler } from './create-invoice.handler';

const decimal = (value: string) => ({ toFixed: () => value });

describe('CreateInvoiceHandler', () => {
  let handler: CreateInvoiceHandler;
  let prisma: { forTenant: jest.Mock };
  let eventBus: { publish: jest.Mock };
  let contracts: { send: jest.Mock };
  let tenants: { send: jest.Mock };
  let tx: { invoice: { create: jest.Mock } };

  const command = new CreateInvoiceCommand('tenant-1', 'milestone-1', 'corr-1');

  const milestone = (overrides: Record<string, unknown> = {}) => ({
    id: 'milestone-1',
    contractId: 'contract-1',
    clientId: 'client-1',
    title: 'Design',
    amount: '1000.00',
    currency: 'EUR',
    status: 'COMPLETE',
    contractStatus: 'ACTIVE',
    ...overrides,
  });

  beforeEach(async () => {
    tx = { invoice: { create: jest.fn() } };
    prisma = {
      forTenant: jest.fn(
        (_tenantId: string, fn: (tx: TenantScopedClient) => unknown) =>
          fn(tx as unknown as TenantScopedClient),
      ),
    };
    eventBus = { publish: jest.fn() };
    contracts = { send: jest.fn(() => of(milestone())) };
    tenants = {
      send: jest.fn(() => of({ id: 'tenant-1', name: 'Acme', country: 'FR' })),
    };

    tx.invoice.create.mockResolvedValue({
      id: 'invoice-1',
      total: decimal('1200.00'),
      currency: 'EUR',
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        CreateInvoiceHandler,
        TaxService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventBus, useValue: eventBus },
        { provide: CONTRACTS_CLIENT, useValue: contracts },
        { provide: TENANTS_CLIENT, useValue: tenants },
      ],
    }).compile();

    handler = moduleRef.get(CreateInvoiceHandler);
  });

  describe('the milestone must be complete', () => {
    it('refuses to invoice a pending milestone', async () => {
      contracts.send.mockReturnValue(of(milestone({ status: 'PENDING' })));

      await expect(handler.execute(command)).rejects.toBeInstanceOf(
        RpcException,
      );
      // Nothing was written and nothing was announced — a rejected command
      // must leave no trace.
      expect(tx.invoice.create).not.toHaveBeenCalled();
      expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('refuses to invoice against a cancelled contract', async () => {
      contracts.send.mockReturnValue(
        of(milestone({ contractStatus: 'CANCELLED' })),
      );

      await expect(handler.execute(command)).rejects.toBeInstanceOf(
        RpcException,
      );
    });
  });

  describe('tax', () => {
    it('applies the rate for the tenant country', async () => {
      await handler.execute(command);

      const calls = tx.invoice.create.mock.calls as Array<
        [
          {
            data: {
              subtotal: number;
              taxRate: number;
              taxAmount: number;
              total: number;
            };
          },
        ]
      >;
      const data = calls[0][0].data;

      // FR = 20%: 1000 → 200 tax → 1200 total.
      expect(data.subtotal).toBe(1000);
      expect(data.taxRate).toBe(20);
      expect(data.taxAmount).toBe(200);
      expect(data.total).toBe(1200);
    });

    it('uses a different rate for a different country', async () => {
      tenants.send.mockReturnValue(
        of({ id: 'tenant-1', name: 'Globex', country: 'DE' }),
      );

      await handler.execute(command);

      const calls = tx.invoice.create.mock.calls as Array<
        [{ data: { taxRate: number; total: number } }]
      >;
      // DE = 19%.
      expect(calls[0][0].data.taxRate).toBe(19);
      expect(calls[0][0].data.total).toBe(1190);
    });

    it('falls back to zero rather than guessing for an unknown country', async () => {
      tenants.send.mockReturnValue(
        of({ id: 'tenant-1', name: 'Elsewhere', country: 'ZZ' }),
      );

      await handler.execute(command);

      const calls = tx.invoice.create.mock.calls as Array<
        [{ data: { taxRate: number; total: number } }]
      >;
      // An invoice with a guessed tax rate is a legal document with the wrong
      // number on it. Zero is visible and checkable.
      expect(calls[0][0].data.taxRate).toBe(0);
      expect(calls[0][0].data.total).toBe(1000);
    });
  });

  describe('the invoice record', () => {
    it('starts as PENDING, because no PDF exists yet', async () => {
      await handler.execute(command);

      const calls = tx.invoice.create.mock.calls as Array<
        [{ data: { status: string } }]
      >;
      expect(calls[0][0].data.status).toBe('PENDING');
    });

    it('turns a duplicate into a 409 rather than a 500', async () => {
      // The unique constraint on milestone_id is the real guard: two
      // concurrent commands would both pass an application-level check.
      tx.invoice.create.mockRejectedValue({ code: 'P2002' });

      const error = await handler
        .execute(command)
        .catch((e: RpcException) => e.getError());

      expect(error).toMatchObject({ status: 409 });
    });

    it('rethrows errors it does not recognise', async () => {
      tx.invoice.create.mockRejectedValue(new Error('connection lost'));

      await expect(handler.execute(command)).rejects.toThrow('connection lost');
    });
  });

  describe('the event', () => {
    it('publishes InvoiceCreatedEvent on success', async () => {
      await handler.execute(command);

      expect(eventBus.publish).toHaveBeenCalledTimes(1);
      const calls = eventBus.publish.mock.calls as Array<[InvoiceCreatedEvent]>;
      const published = calls[0][0];

      expect(published).toBeInstanceOf(InvoiceCreatedEvent);
      expect(published.invoiceId).toBe('invoice-1');
      // The correlation ID survives into the event, which is what lets the
      // whole saga be traced as one request.
      expect(published.correlationId).toBe('corr-1');
    });

    it('does not publish when the downstream lookup fails', async () => {
      contracts.send.mockReturnValue(
        throwError(() => ({ status: 404, message: 'Milestone not found' })),
      );

      await expect(handler.execute(command)).rejects.toBeInstanceOf(
        RpcException,
      );
      expect(eventBus.publish).not.toHaveBeenCalled();
    });
  });
});
