import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import { AuthUserDto, TenantDto, UserRoleDto } from '@forge/contracts';
import { PrismaService } from '@forge/prisma';

/**
 * Reads users within the caller's tenant.
 *
 * Note the absence of `where: { tenantId }` in these queries. That is not an
 * oversight — `forTenant` sets the Postgres tenant context and RLS applies the
 * restriction. Adding a redundant filter would suggest the isolation depends
 * on remembering it, which is the failure mode RLS exists to remove.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string): Promise<AuthUserDto[]> {
    const users = await this.prisma.forTenant(tenantId, (tx) =>
      tx.user.findMany({ orderBy: { createdAt: 'asc' } }),
    );

    return users.map(toAuthUser);
  }

  /**
   * Reads the tenant itself. Billing calls this for the country that drives
   * the invoice tax rate.
   */
  async getTenant(tenantId: string): Promise<TenantDto> {
    const tenant = await this.prisma.forTenant(tenantId, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId } }),
    );

    if (!tenant) {
      throw new RpcException({ status: 404, message: 'Tenant not found' });
    }

    return { id: tenant.id, name: tenant.name, country: tenant.country };
  }

  async get(tenantId: string, userId: string): Promise<AuthUserDto> {
    const user = await this.prisma.forTenant(tenantId, (tx) =>
      tx.user.findUnique({ where: { id: userId } }),
    );

    // A user in another tenant is invisible to RLS, so this is indistinguishable
    // from a user that does not exist. That is the correct behaviour: a
    // different error for "exists but not yours" would confirm the ID is real.
    if (!user) {
      throw new RpcException({ status: 404, message: 'User not found' });
    }

    return toAuthUser(user);
  }
}

function toAuthUser(user: {
  id: string;
  tenantId: string;
  email: string;
  role: string;
}): AuthUserDto {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role as UserRoleDto,
  };
}
