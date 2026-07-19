import { Test } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';
import * as bcrypt from 'bcrypt';

import { PrismaService, TenantScopedClient } from '@forge/prisma';

import { AuthService } from './auth.service';
import { TokenService } from './token.service';

/** Shape of the transaction stub handed to `forTenant`'s callback. */
type TxStub = {
  tenant: { create: jest.Mock };
  user: { create: jest.Mock };
};

/** Runs the `forTenant` callback against a stub instead of a real transaction. */
function runWithTx(tx: TxStub | Record<string, never>) {
  return (_tenantId: string, fn: (tx: TenantScopedClient) => unknown) =>
    fn(tx as unknown as TenantScopedClient);
}

/**
 * The database is mocked here on purpose. These tests pin *decision* logic —
 * which credential failures are indistinguishable, when a reuse triggers a
 * family revocation. The RLS behaviour they sit on top of cannot be mocked
 * meaningfully and is covered by the e2e suite against real Postgres.
 */
describe('AuthService', () => {
  let service: AuthService;
  let prisma: { forTenant: jest.Mock };
  let tokens: {
    issueTokenPair: jest.Mock;
    findStoredToken: jest.Mock;
    revoke: jest.Mock;
    revokeAllForUser: jest.Mock;
  };

  const tokenPair = { accessToken: 'access', refreshToken: 'refresh' };

  beforeEach(async () => {
    prisma = { forTenant: jest.fn() };
    tokens = {
      issueTokenPair: jest.fn().mockResolvedValue(tokenPair),
      findStoredToken: jest.fn(),
      revoke: jest.fn(),
      revokeAllForUser: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: TokenService, useValue: tokens },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('signup', () => {
    it('creates the first user as OWNER and issues tokens in one transaction', async () => {
      const created: {
        id: string;
        tenantId: string;
        email: string;
        role: string;
      } = {
        id: 'user-1',
        tenantId: 'tenant-1',
        email: 'owner@acme.test',
        role: 'OWNER',
      };
      const tx: TxStub = {
        tenant: { create: jest.fn().mockResolvedValue({ id: 'tenant-1' }) },
        user: { create: jest.fn().mockResolvedValue(created) },
      };
      prisma.forTenant.mockImplementation(runWithTx(tx));

      const result = await service.signup({
        correlationId: 'c-1',
        tenant: { name: 'Acme', country: 'fr' },
        owner: { email: 'Owner@Acme.test', password: 'a-long-password' },
      });

      expect(result.user.role).toBe('OWNER');

      // Reading the recorded arguments directly rather than through
      // `expect.objectContaining`, which is typed as `any` and would switch
      // off checking for the whole assertion.
      const userCalls = tx.user.create.mock.calls as Array<
        [{ data: { email: string; role: string } }]
      >;
      const tenantCalls = tx.tenant.create.mock.calls as Array<
        [{ data: { country: string } }]
      >;

      // Lower-cased on the way in, so "Owner@" and "owner@" cannot become two
      // separate accounts in the same tenant.
      expect(userCalls[0][0].data.email).toBe('owner@acme.test');
      // Country is normalised for the Sprint 3 tax lookup.
      expect(tenantCalls[0][0].data.country).toBe('FR');
      // Issued with the transaction client — the refresh_tokens insert is
      // subject to RLS and needs the tenant context this transaction holds.
      expect(tokens.issueTokenPair).toHaveBeenCalledWith(expect.anything(), tx);
    });

    it('stores a bcrypt hash, never the password', async () => {
      const tx: TxStub = {
        tenant: { create: jest.fn().mockResolvedValue({ id: 'tenant-1' }) },
        user: {
          create: jest.fn().mockResolvedValue({
            id: 'u',
            tenantId: 't',
            email: 'e@e.test',
            role: 'OWNER',
          }),
        },
      };
      prisma.forTenant.mockImplementation(runWithTx(tx));

      await service.signup({
        correlationId: 'c-1',
        tenant: { name: 'Acme', country: 'FR' },
        owner: { email: 'e@e.test', password: 'plaintext-password' },
      });

      const calls = tx.user.create.mock.calls as Array<
        [{ data: { passwordHash: string } }]
      >;
      const stored = calls[0][0].data.passwordHash;
      expect(stored).not.toBe('plaintext-password');
      expect(stored).toMatch(/^\$2[aby]\$/);
      expect(await bcrypt.compare('plaintext-password', stored)).toBe(true);
    });
  });

  describe('login', () => {
    const request = {
      correlationId: 'c-1',
      tenantId: 'tenant-1',
      email: 'owner@acme.test',
      password: 'right-password',
    };

    it('rejects a wrong password', async () => {
      const hash = await bcrypt.hash('right-password', 4);
      prisma.forTenant.mockResolvedValue({
        id: 'u',
        tenantId: 'tenant-1',
        email: 'owner@acme.test',
        role: 'OWNER',
        passwordHash: hash,
      });

      await expect(
        service.login({ ...request, password: 'wrong-password' }),
      ).rejects.toBeInstanceOf(RpcException);
    });

    it('gives an identical error for unknown user and wrong password', async () => {
      // Different errors here would let an attacker enumerate which email
      // addresses hold accounts, one request at a time.
      prisma.forTenant.mockResolvedValue(null);
      const unknownUser = await service
        .login(request)
        .catch((error: RpcException) => error.getError());

      const hash = await bcrypt.hash('right-password', 4);
      prisma.forTenant.mockResolvedValue({
        id: 'u',
        tenantId: 'tenant-1',
        email: 'owner@acme.test',
        role: 'OWNER',
        passwordHash: hash,
      });
      const wrongPassword = await service
        .login({ ...request, password: 'nope' })
        .catch((error: RpcException) => error.getError());

      expect(unknownUser).toEqual(wrongPassword);
    });

    it('issues tokens on valid credentials', async () => {
      const hash = await bcrypt.hash('right-password', 4);
      prisma.forTenant.mockResolvedValue({
        id: 'u',
        tenantId: 'tenant-1',
        email: 'owner@acme.test',
        role: 'MEMBER',
        passwordHash: hash,
      });

      const result = await service.login(request);

      expect(result.tokens).toEqual(tokenPair);
      expect(result.user.role).toBe('MEMBER');
    });
  });

  describe('refresh', () => {
    const request = {
      correlationId: 'c-1',
      tenantId: 'tenant-1',
      refreshToken: 'presented',
    };

    const storedToken = (overrides: Record<string, unknown> = {}) => ({
      id: 'token-1',
      userId: 'user-1',
      revokedAt: null,
      replacedById: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'user-1',
        tenantId: 'tenant-1',
        email: 'owner@acme.test',
        role: 'OWNER',
      },
      ...overrides,
    });

    it('rotates a valid token, passing the old ID as replaced', async () => {
      tokens.findStoredToken.mockResolvedValue(storedToken());
      prisma.forTenant.mockImplementation(runWithTx({}));

      await service.refresh(request);

      expect(tokens.issueTokenPair).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'token-1',
      );
    });

    it('rejects an unknown token', async () => {
      tokens.findStoredToken.mockResolvedValue(null);

      await expect(service.refresh(request)).rejects.toBeInstanceOf(
        RpcException,
      );
    });

    it('rejects an expired token', async () => {
      tokens.findStoredToken.mockResolvedValue(
        storedToken({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(service.refresh(request)).rejects.toBeInstanceOf(
        RpcException,
      );
      expect(tokens.issueTokenPair).not.toHaveBeenCalled();
    });

    it('revokes every session when an already-rotated token is replayed', async () => {
      // The honest client holds the replacement, so this copy leaked.
      tokens.findStoredToken.mockResolvedValue(
        storedToken({ revokedAt: new Date(), replacedById: 'token-2' }),
      );

      await expect(service.refresh(request)).rejects.toBeInstanceOf(
        RpcException,
      );
      expect(tokens.revokeAllForUser).toHaveBeenCalledWith(
        'tenant-1',
        'user-1',
      );
    });

    it('does NOT nuke sessions for a token revoked by logout', async () => {
      // No `replacedById` means it was never rotated — this is an ordinary
      // stale token, and treating it as a breach would fire alarms every time
      // someone reuses a logged-out session.
      tokens.findStoredToken.mockResolvedValue(
        storedToken({ revokedAt: new Date(), replacedById: null }),
      );

      await expect(service.refresh(request)).rejects.toBeInstanceOf(
        RpcException,
      );
      expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes a live token', async () => {
      tokens.findStoredToken.mockResolvedValue({
        id: 'token-1',
        revokedAt: null,
      });

      await service.logout({
        correlationId: 'c-1',
        tenantId: 'tenant-1',
        refreshToken: 'presented',
      });

      expect(tokens.revoke).toHaveBeenCalledWith('tenant-1', 'token-1');
    });

    it('reports success for an unknown token instead of leaking its status', async () => {
      tokens.findStoredToken.mockResolvedValue(null);

      await expect(
        service.logout({
          correlationId: 'c-1',
          tenantId: 'tenant-1',
          refreshToken: 'never-existed',
        }),
      ).resolves.toEqual({ success: true });
      expect(tokens.revoke).not.toHaveBeenCalled();
    });
  });
});
