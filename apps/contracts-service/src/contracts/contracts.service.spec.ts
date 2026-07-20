import { Test } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';

import { ContractStatusDto } from '@forge/contracts';
import { PrismaService, TenantScopedClient } from '@forge/prisma';

import { ContractsService } from './contracts.service';

/** Minimal stand-in for a Prisma Decimal. */
const decimal = (value: string) => ({ toFixed: () => value });

type TxStub = {
  client: { findUnique: jest.Mock };
  contract: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  milestone: { findUnique: jest.Mock; update: jest.Mock };
};

function makeTx(overrides: Partial<TxStub> = {}): TxStub {
  return {
    client: { findUnique: jest.fn() },
    contract: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    milestone: { findUnique: jest.fn(), update: jest.fn() },
    ...overrides,
  };
}

const contractRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'contract-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  title: 'Website rebuild',
  description: null,
  status: 'DRAFT',
  currency: 'EUR',
  startDate: null,
  endDate: null,
  milestones: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const milestoneRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'milestone-1',
  contractId: 'contract-1',
  title: 'Design',
  amount: decimal('2500.50'),
  dueDate: new Date('2026-09-01'),
  status: 'PENDING',
  completedAt: null,
  ...overrides,
});

describe('ContractsService', () => {
  let service: ContractsService;
  let prisma: { forTenant: jest.Mock };

  beforeEach(async () => {
    prisma = { forTenant: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(ContractsService);
  });

  function withTx(tx: TxStub) {
    prisma.forTenant.mockImplementation(
      (_tenantId: string, fn: (tx: TenantScopedClient) => unknown) =>
        fn(tx as unknown as TenantScopedClient),
    );
  }

  const createRequest = {
    correlationId: 'c-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    title: 'Website rebuild',
    milestones: [{ title: 'Design', amount: 2500.5, dueDate: '2026-09-01' }],
  };

  describe('create', () => {
    it('creates the contract and its milestones in one write', async () => {
      const tx = makeTx();
      tx.client.findUnique.mockResolvedValue({
        id: 'client-1',
        archivedAt: null,
      });
      tx.contract.create.mockResolvedValue(
        contractRow({ milestones: [milestoneRow()] }),
      );
      withTx(tx);

      const result = await service.create(createRequest);

      // A nested create, not two round-trips: a contract with no milestones is
      // a state the DTO forbids but the database would happily hold.
      const calls = tx.contract.create.mock.calls as Array<
        [{ data: { milestones: { create: unknown[] } } }]
      >;
      expect(calls[0][0].data.milestones.create).toHaveLength(1);
      expect(result.milestones).toHaveLength(1);
    });

    it('defaults the currency to EUR', async () => {
      const tx = makeTx();
      tx.client.findUnique.mockResolvedValue({
        id: 'client-1',
        archivedAt: null,
      });
      tx.contract.create.mockResolvedValue(contractRow());
      withTx(tx);

      await service.create(createRequest);

      const calls = tx.contract.create.mock.calls as Array<
        [{ data: { currency: string } }]
      >;
      expect(calls[0][0].data.currency).toBe('EUR');
    });

    it('rejects a client that does not exist in this tenant', async () => {
      const tx = makeTx();
      // RLS makes another tenant's client return null here, so "not found" and
      // "belongs to someone else" are deliberately the same case.
      tx.client.findUnique.mockResolvedValue(null);
      withTx(tx);

      await expect(service.create(createRequest)).rejects.toBeInstanceOf(
        RpcException,
      );
      expect(tx.contract.create).not.toHaveBeenCalled();
    });

    it('refuses to contract with an archived client', async () => {
      const tx = makeTx();
      tx.client.findUnique.mockResolvedValue({
        id: 'client-1',
        archivedAt: new Date(),
      });
      withTx(tx);

      await expect(service.create(createRequest)).rejects.toBeInstanceOf(
        RpcException,
      );
    });
  });

  describe('status transitions', () => {
    async function attemptTransition(from: string, to: ContractStatusDto) {
      const tx = makeTx();
      tx.contract.findUnique.mockResolvedValue(contractRow({ status: from }));
      tx.contract.update.mockResolvedValue(contractRow({ status: to }));
      withTx(tx);

      return service
        .update({
          correlationId: 'c-1',
          tenantId: 'tenant-1',
          contractId: 'contract-1',
          status: to,
        })
        .then(
          () => 'allowed' as const,
          () => 'rejected' as const,
        );
    }

    it('allows DRAFT to ACTIVE and DRAFT to CANCELLED', async () => {
      expect(await attemptTransition('DRAFT', ContractStatusDto.ACTIVE)).toBe(
        'allowed',
      );
      expect(
        await attemptTransition('DRAFT', ContractStatusDto.CANCELLED),
      ).toBe('allowed');
    });

    it('allows ACTIVE to COMPLETED', async () => {
      expect(
        await attemptTransition('ACTIVE', ContractStatusDto.COMPLETED),
      ).toBe('allowed');
    });

    it('rejects skipping DRAFT straight to COMPLETED', async () => {
      expect(
        await attemptTransition('DRAFT', ContractStatusDto.COMPLETED),
      ).toBe('rejected');
    });

    it('treats COMPLETED and CANCELLED as terminal', async () => {
      // A completed contract dragged back to DRAFT would let its issued
      // invoices disagree with it.
      expect(
        await attemptTransition('COMPLETED', ContractStatusDto.ACTIVE),
      ).toBe('rejected');
      expect(
        await attemptTransition('CANCELLED', ContractStatusDto.ACTIVE),
      ).toBe('rejected');
      expect(
        await attemptTransition('COMPLETED', ContractStatusDto.CANCELLED),
      ).toBe('rejected');
    });
  });

  describe('completeMilestone', () => {
    it('marks a pending milestone complete and stamps the time', async () => {
      const tx = makeTx();
      tx.milestone.findUnique.mockResolvedValue({
        ...milestoneRow(),
        contract: { status: 'ACTIVE' },
      });
      tx.milestone.update.mockResolvedValue(
        milestoneRow({ status: 'COMPLETE', completedAt: new Date() }),
      );
      withTx(tx);

      const result = await service.completeMilestone(
        'tenant-1',
        'contract-1',
        'milestone-1',
      );

      expect(result.status).toBe('COMPLETE');
      expect(result.completedAt).not.toBeNull();
    });

    it('rejects a milestone belonging to a different contract', async () => {
      const tx = makeTx();
      // RLS scopes to the tenant, not to the contract — so a milestone from
      // another of the tenant's own contracts would otherwise be accepted.
      tx.milestone.findUnique.mockResolvedValue({
        ...milestoneRow({ contractId: 'a-different-contract' }),
        contract: { status: 'ACTIVE' },
      });
      withTx(tx);

      await expect(
        service.completeMilestone('tenant-1', 'contract-1', 'milestone-1'),
      ).rejects.toBeInstanceOf(RpcException);
      expect(tx.milestone.update).not.toHaveBeenCalled();
    });

    it('refuses to complete a milestone twice', async () => {
      const tx = makeTx();
      tx.milestone.findUnique.mockResolvedValue({
        ...milestoneRow({ status: 'COMPLETE' }),
        contract: { status: 'ACTIVE' },
      });
      withTx(tx);

      await expect(
        service.completeMilestone('tenant-1', 'contract-1', 'milestone-1'),
      ).rejects.toBeInstanceOf(RpcException);
    });

    it('refuses to complete a milestone on a non-active contract', async () => {
      const tx = makeTx();
      tx.milestone.findUnique.mockResolvedValue({
        ...milestoneRow(),
        contract: { status: 'DRAFT' },
      });
      withTx(tx);

      await expect(
        service.completeMilestone('tenant-1', 'contract-1', 'milestone-1'),
      ).rejects.toBeInstanceOf(RpcException);
    });
  });

  describe('serialisation', () => {
    it('renders money with its minor units, as a string', async () => {
      const tx = makeTx();
      tx.contract.findUnique.mockResolvedValue(
        contractRow({ milestones: [milestoneRow()] }),
      );
      withTx(tx);

      const contract = await service.get('tenant-1', 'contract-1');

      // A JSON number would be an IEEE 754 double, reintroducing exactly the
      // rounding drift Decimal was chosen to avoid.
      expect(contract.milestones[0].amount).toBe('2500.50');
      expect(typeof contract.milestones[0].amount).toBe('string');
    });
  });
});
