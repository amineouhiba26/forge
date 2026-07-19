import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as bcrypt from 'bcrypt';

import {
  AuthResultDto,
  LoginRpcRequest,
  LogoutRpcRequest,
  RefreshRpcRequest,
  SignupRpcRequest,
  UserRoleDto,
} from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

import { TokenService, TokenSubject } from './token.service';

/**
 * Work factor for password hashing. 12 is roughly 250ms on current hardware —
 * slow enough to make offline cracking expensive, fast enough that login does
 * not feel broken. Raise it as hardware improves.
 */
const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Creates a Tenant and its first User, who is necessarily the OWNER.
   *
   * The tenant ID is generated here rather than by the database because the
   * RLS context has to be set *before* the rows are written — and setting it
   * requires knowing the ID. This is the one flow that legitimately runs
   * without an existing tenant context.
   */
  async signup(request: SignupRpcRequest): Promise<AuthResultDto> {
    const tenantId = randomUUID();
    const passwordHash = await bcrypt.hash(
      request.owner.password,
      BCRYPT_ROUNDS,
    );

    const result = await this.prisma.forTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          id: tenantId,
          name: request.tenant.name,
          country: request.tenant.country.toUpperCase(),
        },
      });

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: request.owner.email.toLowerCase(),
          passwordHash,
          role: 'OWNER',
        },
      });

      const subject: TokenSubject = {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        role: user.role as UserRoleDto,
      };

      // Issued inside the same transaction: the refresh_tokens insert is
      // subject to RLS and needs this tenant context to be allowed at all.
      const tokenPair = await this.tokens.issueTokenPair(subject, tx);

      return { user, tokens: tokenPair };
    });

    this.logger.log(
      `Tenant created: ${tenantId} (correlationId=${request.correlationId})`,
    );

    return {
      user: {
        id: result.user.id,
        tenantId: result.user.tenantId,
        email: result.user.email,
        role: result.user.role as UserRoleDto,
      },
      tokens: result.tokens,
    };
  }

  async login(request: LoginRpcRequest): Promise<AuthResultDto> {
    const user = await this.prisma.forTenant(request.tenantId, (tx) =>
      tx.user.findUnique({
        where: {
          tenantId_email: {
            tenantId: request.tenantId,
            email: request.email.toLowerCase(),
          },
        },
      }),
    );

    // Hash even when no user matched, against a dummy value. Returning early
    // would make "unknown email" measurably faster than "wrong password",
    // which is enough to enumerate valid accounts by timing alone.
    const passwordMatches = await bcrypt.compare(
      request.password,
      user?.passwordHash ?? DUMMY_HASH,
    );

    if (!user || !passwordMatches) {
      // One message for both cases, for the same reason.
      throw new RpcException({
        status: 401,
        message: 'Invalid credentials',
      });
    }

    const subject: TokenSubject = {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role as UserRoleDto,
    };

    return {
      user: {
        id: subject.id,
        tenantId: subject.tenantId,
        email: subject.email,
        role: subject.role,
      },
      tokens: await this.tokens.issueTokenPair(subject),
    };
  }

  /**
   * Rotates a refresh token: the presented one is revoked and a new pair is
   * issued in the same transaction.
   *
   * Rotation limits the damage of a stolen refresh token — it is usable once,
   * and using it locks out whoever holds the other copy.
   */
  async refresh(request: RefreshRpcRequest): Promise<AuthResultDto> {
    const tenantId = request.tenantId;

    const stored = await this.tokens.findStoredToken(
      tenantId,
      request.refreshToken,
    );

    if (!stored) {
      throw new RpcException({ status: 401, message: 'Invalid refresh token' });
    }

    if (stored.revokedAt) {
      // `replacedById` is what separates the two ways a token gets revoked.
      //
      // Set  → it was rotated out, and the honest client holds the
      //        replacement. Seeing this copy again means it leaked, so every
      //        session for the user is killed rather than guessing which
      //        party is the attacker.
      // Null → it was revoked by an ordinary logout. Presenting it again is
      //        an ordinary stale-token error, not evidence of compromise, and
      //        treating it as an attack would fire alarms on a normal event.
      if (stored.replacedById) {
        this.logger.warn(
          `Refresh token reuse detected for user ${stored.userId} — revoking all sessions ` +
            `(correlationId=${request.correlationId})`,
        );
        await this.tokens.revokeAllForUser(tenantId, stored.userId);
      }

      throw new RpcException({ status: 401, message: 'Invalid refresh token' });
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new RpcException({ status: 401, message: 'Refresh token expired' });
    }

    const subject: TokenSubject = {
      id: stored.user.id,
      tenantId: stored.user.tenantId,
      email: stored.user.email,
      role: stored.user.role as UserRoleDto,
    };

    const tokenPair = await this.prisma.forTenant(tenantId, (tx) =>
      this.tokens.issueTokenPair(subject, tx, stored.id),
    );

    return {
      user: {
        id: subject.id,
        tenantId: subject.tenantId,
        email: subject.email,
        role: subject.role,
      },
      tokens: tokenPair,
    };
  }

  /** Revokes the presented refresh token. Idempotent by design. */
  async logout(request: LogoutRpcRequest): Promise<{ success: true }> {
    const stored = await this.tokens.findStoredToken(
      request.tenantId,
      request.refreshToken,
    );

    if (stored && !stored.revokedAt) {
      await this.tokens.revoke(request.tenantId, stored.id);
    }

    // Always reports success: telling a caller that a token was already
    // invalid is information it has no use for and an attacker does.
    return { success: true };
  }
}

/**
 * A real bcrypt hash of a value nobody can supply, used to keep the failure
 * path as slow as the success path. Must be a valid hash or bcrypt returns
 * immediately and the timing difference reappears.
 */
const DUMMY_HASH =
  '$2b$12$C6UzMDM.H6dfI/f/IKcEe.gLzZbLPP0nO1sMSm.PtMKzZ4dJKa5vy';
