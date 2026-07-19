import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import {
  AccessTokenClaims,
  DurationString,
  TokenPairDto,
  UserRoleDto,
} from '@forge/contracts';
import { PrismaService, TenantScopedClient } from '@forge/prisma';

export interface TokenSubject {
  id: string;
  tenantId: string;
  email: string;
  role: UserRoleDto;
}

/**
 * Issues, rotates and revokes tokens.
 *
 * Split from AuthService because the two answer different questions:
 * AuthService decides *whether* someone is who they claim to be; this decides
 * what a proven identity is handed and for how long.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Refresh tokens are opaque random strings, not JWTs.
   *
   * A JWT would be self-describing and verifiable without a database lookup —
   * which is exactly wrong here, because every refresh *must* hit the database
   * to check revocation. Random bytes give the same security with no illusion
   * that the token can be trusted on its own.
   */
  private generateRefreshToken(): string {
    return randomBytes(48).toString('base64url');
  }

  /**
   * Refresh tokens are stored as SHA-256 digests, never in the clear.
   *
   * Unlike a password, a bcrypt-style slow hash buys nothing here: the input is
   * 48 random bytes, so there is no dictionary to try and no work factor worth
   * paying on every refresh. The only property needed is that a database dump
   * cannot be replayed as a set of live sessions.
   */
  private hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private signAccessToken(subject: TokenSubject): string {
    const claims: AccessTokenClaims = {
      sub: subject.id,
      tenantId: subject.tenantId,
      email: subject.email,
      role: subject.role,
    };

    return this.jwt.sign(claims, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      // Safe to assert: the Joi schema rejects anything not matching this
      // shape, so the process never boots with a value that breaks here.
      expiresIn: this.config.getOrThrow<DurationString>('JWT_ACCESS_TTL'),
    });
  }

  private refreshTokenExpiry(): Date {
    const ttl = this.config.getOrThrow<DurationString>('JWT_REFRESH_TTL');
    return new Date(Date.now() + parseDuration(ttl));
  }

  /**
   * Issues a fresh pair and records the refresh token.
   *
   * Takes an optional transaction client so callers already inside a
   * tenant-scoped transaction (signup, rotation) reuse it — the
   * `refresh_tokens` insert is subject to RLS and needs that tenant context.
   */
  async issueTokenPair(
    subject: TokenSubject,
    tx?: TenantScopedClient,
    replacesTokenId?: string,
  ): Promise<TokenPairDto> {
    const refreshToken = this.generateRefreshToken();

    const persist = async (client: TenantScopedClient): Promise<void> => {
      const created = await client.refreshToken.create({
        data: {
          tenantId: subject.tenantId,
          userId: subject.id,
          tokenHash: this.hashRefreshToken(refreshToken),
          expiresAt: this.refreshTokenExpiry(),
        },
      });

      if (replacesTokenId) {
        // Links the old token to its replacement, forming the chain that
        // makes reuse detectable.
        await client.refreshToken.update({
          where: { id: replacesTokenId },
          data: { revokedAt: new Date(), replacedById: created.id },
        });
      }
    };

    if (tx) {
      await persist(tx);
    } else {
      await this.prisma.forTenant(subject.tenantId, persist);
    }

    return { accessToken: this.signAccessToken(subject), refreshToken };
  }

  /** Looks up a stored refresh token by its hash, within a tenant's scope. */
  async findStoredToken(tenantId: string, presentedToken: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.refreshToken.findUnique({
        where: { tokenHash: this.hashRefreshToken(presentedToken) },
        include: { user: true },
      }),
    );
  }

  /** Revokes a single token — the logout path. */
  async revoke(tenantId: string, tokenId: string): Promise<void> {
    await this.prisma.forTenant(tenantId, (tx) =>
      tx.refreshToken.update({
        where: { id: tokenId },
        data: { revokedAt: new Date() },
      }),
    );
  }

  /**
   * Revokes every outstanding token for a user.
   *
   * Called when an already-rotated token is presented a second time. That
   * should be impossible for an honest client — it rotated, so it holds the
   * replacement — which means the old token leaked. Since it cannot be known
   * whether the attacker or the legitimate user is holding it, the safe move
   * is to end every session and force a fresh login.
   */
  async revokeAllForUser(tenantId: string, userId: string): Promise<void> {
    await this.prisma.forTenant(tenantId, (tx) =>
      tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }
}

/** Converts `15m` / `7d` / `3600s` into milliseconds. */
export function parseDuration(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);

  if (!match) {
    throw new Error(
      `Invalid duration "${ttl}". Expected a number followed by s, m, h or d.`,
    );
  }

  const amount = Number(match[1]);
  const unitMs: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  return amount * unitMs[match[2]];
}
