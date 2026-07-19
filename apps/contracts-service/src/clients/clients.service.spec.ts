import { Test } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';

import { PrismaService, TenantScopedClient } from '@forge/prisma';

import { ClientsService } from './clients.service';

type TxStub = {
  client: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
};

function makeTx(): TxStub {
  return {
    client: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  };
}

const clientRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'client-1',
  tenantId: 'tenant-1',
  name: 'Wayne Enterprises',
  email: 'pay@wayne.test',
  companyName: null,
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('ClientsService', () => {
  let service: ClientsService;
  let prisma: { forTenant: jest.Mock };

  beforeEach(async () => {
    prisma = { forTenant: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [ClientsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(ClientsService);
  });

  function withTx(tx: TxStub) {
    prisma.forTenant.mockImplementation(
      (_tenantId: string, fn: (tx: TenantScopedClient) => unknown) =>
        fn(tx as unknown as TenantScopedClient),
    );
  }

  describe('create', () => {
    it('lower-cases the email so casing cannot create a duplicate', async () => {
      const tx = makeTx();
      tx.client.create.mockResolvedValue(clientRow());
      withTx(tx);

      await service.create({
        correlationId: 'c-1',
        tenantId: 'tenant-1',
        name: 'Wayne',
        email: 'Pay@Wayne.TEST',
      });

      // Cast the calls array before indexing: `mock.calls` is `any[]`, so
      // indexing first and casting after leaves the access unchecked.
      const calls = tx.client.create.mock.calls as Array<
        [{ data: { email: string } }]
      >;
      expect(calls[0][0].data.email).toBe('pay@wayne.test');
    });

    it('turns a unique violation into a 409 rather than a 500', async () => {
      const tx = makeTx();
      // P2002 is Prisma's unique-constraint code. Letting it escape would
      // surface as an opaque server error and leak the constraint name.
      tx.client.create.mockRejectedValue({ code: 'P2002' });
      withTx(tx);

      const error = await service
        .create({
          correlationId: 'c-1',
          tenantId: 'tenant-1',
          name: 'Wayne',
          email: 'pay@wayne.test',
        })
        .catch((e: RpcException) => e.getError());

      expect(error).toMatchObject({ status: 409 });
    });

    it('rethrows errors it does not recognise', async () => {
      const tx = makeTx();
      tx.client.create.mockRejectedValue(new Error('connection lost'));
      withTx(tx);

      await expect(
        service.create({
          correlationId: 'c-1',
          tenantId: 'tenant-1',
          name: 'Wayne',
          email: 'pay@wayne.test',
        }),
      ).rejects.toThrow('connection lost');
    });
  });

  describe('list', () => {
    it('hides archived clients unless asked for', async () => {
      const tx = makeTx();
      tx.client.findMany.mockResolvedValue([clientRow()]);
      tx.client.count.mockResolvedValue(1);
      withTx(tx);

      await service.list({
        correlationId: 'c-1',
        tenantId: 'tenant-1',
        page: 1,
        limit: 20,
      });

      const calls = tx.client.findMany.mock.calls as Array<
        [{ where: { archivedAt?: null } }]
      >;
      expect(calls[0][0].where.archivedAt).toBeNull();
    });

    it('includes archived clients when asked', async () => {
      const tx = makeTx();
      tx.client.findMany.mockResolvedValue([]);
      tx.client.count.mockResolvedValue(0);
      withTx(tx);

      await service.list({
        correlationId: 'c-1',
        tenantId: 'tenant-1',
        includeArchived: true,
        page: 1,
        limit: 20,
      });

      const calls = tx.client.findMany.mock.calls as Array<
        [{ where: { archivedAt?: null } }]
      >;
      expect(calls[0][0].where.archivedAt).toBeUndefined();
    });

    it('reports pagination metadata a client can page through', async () => {
      const tx = makeTx();
      tx.client.findMany.mockResolvedValue([clientRow(), clientRow()]);
      tx.client.count.mockResolvedValue(5);
      withTx(tx);

      const result = await service.list({
        correlationId: 'c-1',
        tenantId: 'tenant-1',
        page: 2,
        limit: 2,
      });

      expect(result.total).toBe(5);
      expect(result.page).toBe(2);
      expect(result.totalPages).toBe(3);
    });

    it('offsets by page, so page 3 skips the first two pages', async () => {
      const tx = makeTx();
      tx.client.findMany.mockResolvedValue([]);
      tx.client.count.mockResolvedValue(0);
      withTx(tx);

      await service.list({
        correlationId: 'c-1',
        tenantId: 'tenant-1',
        page: 3,
        limit: 20,
      });

      const calls = tx.client.findMany.mock.calls as Array<
        [{ skip: number; take: number }]
      >;
      expect(calls[0][0].skip).toBe(40);
      expect(calls[0][0].take).toBe(20);
    });
  });

  describe('archive', () => {
    it('sets archivedAt rather than deleting the row', async () => {
      const tx = makeTx();
      tx.client.findUnique.mockResolvedValue(clientRow());
      tx.client.update.mockResolvedValue(clientRow({ archivedAt: new Date() }));
      withTx(tx);

      const result = await service.archive('tenant-1', 'client-1');

      expect(result.archivedAt).not.toBeNull();
      const calls = tx.client.update.mock.calls as Array<
        [{ data: { archivedAt: Date } }]
      >;
      expect(calls[0][0].data.archivedAt).toBeInstanceOf(Date);
    });

    it('is idempotent and does not re-stamp the archive time', async () => {
      const archivedAt = new Date('2026-01-01T00:00:00.000Z');
      const tx = makeTx();
      tx.client.findUnique.mockResolvedValue(clientRow({ archivedAt }));
      withTx(tx);

      const result = await service.archive('tenant-1', 'client-1');

      // Re-stamping would falsify when the archive actually happened.
      expect(tx.client.update).not.toHaveBeenCalled();
      expect(result.archivedAt).toBe(archivedAt.toISOString());
    });

    it('404s for a client outside the tenant', async () => {
      const tx = makeTx();
      tx.client.findUnique.mockResolvedValue(null);
      withTx(tx);

      await expect(
        service.archive('tenant-1', 'client-1'),
      ).rejects.toBeInstanceOf(RpcException);
    });
  });

  describe('update', () => {
    it('leaves omitted fields alone rather than nulling them', async () => {
      const tx = makeTx();
      tx.client.findUnique.mockResolvedValue(clientRow());
      tx.client.update.mockResolvedValue(clientRow({ name: 'Renamed' }));
      withTx(tx);

      await service.update({
        correlationId: 'c-1',
        tenantId: 'tenant-1',
        clientId: 'client-1',
        name: 'Renamed',
      });

      // PATCH semantics: only what was sent is written.
      const calls = tx.client.update.mock.calls as Array<
        [{ data: Record<string, unknown> }]
      >;
      expect(calls[0][0].data).toEqual({ name: 'Renamed' });
    });
  });
});
