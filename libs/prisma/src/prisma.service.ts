import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { Prisma, PrismaClient } from './generated/client';

/**
 * The subset of the client available inside a tenant-scoped transaction.
 *
 * Prisma's own `TransactionClient` rather than a hand-rolled `Omit`: it already
 * excludes the methods that are meaningless mid-transaction (`$connect`,
 * `$transaction`, `$on`, …), and it stays correct as the client evolves.
 */
export type TenantScopedClient = Prisma.TransactionClient;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // Prisma 7 connects through a driver adapter rather than a URL baked into
    // the schema. DATABASE_URL is already Joi-validated by the owning app's
    // ConfigModule, so a bad value fails the boot before reaching here.
    //
    // This connects as the *unprivileged* role. Connecting as the owner would
    // bypass every Row-Level Security policy — see the RLS migration.
    super({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
  }

  async onModuleInit(): Promise<void> {
    // Connect eagerly so an unreachable database fails the boot rather than
    // the first request that happens to touch it.
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Runs `fn` with Postgres' tenant context set, so RLS policies resolve to
   * this tenant and nothing else.
   *
   * Everything happens inside one transaction because the context is set with
   * `set_config(..., is_local => true)`, which reverts on commit or rollback.
   * That scoping is essential with a connection pool: without it the setting
   * would linger on a pooled connection and the *next* request to borrow it
   * would silently inherit the previous tenant's context.
   *
   * Note this is not a WHERE clause — it is the tenant identity the database
   * evaluates its policies against. Forgetting a filter inside `fn` leaks
   * nothing; the policies still apply.
   */
  async forTenant<T>(
    tenantId: string,
    fn: (tx: TenantScopedClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      // Parameterised rather than interpolated: `SET LOCAL` cannot take a bind
      // parameter, but `set_config()` can. String-building this would be an
      // SQL injection sink reachable from a JWT claim.
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

      return fn(tx);
    });
  }
}
