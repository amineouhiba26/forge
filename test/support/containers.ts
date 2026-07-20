import { execFileSync } from 'node:child_process';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';

/**
 * Real Postgres and Redis, started per test run and thrown away afterwards.
 *
 * What this replaces: the suites used to require `docker compose up` and a
 * hand-applied migration, then ran against whatever state the developer's
 * database happened to be in. Three consequences, all of which bit during
 * earlier sprints:
 *
 * - Tests depended on setup nobody could see from the test file.
 * - A run could pass because of rows an earlier run left behind.
 * - A stray service on the shared Redis silently competed for messages, which
 *   is what caused the Sprint 5 flake and the misleading failure in Sprint 6.
 *
 * The last one stops being possible by construction: each run gets its own
 * Redis on its own port, so there is nothing to compete with.
 */
export interface TestInfrastructure {
  postgres: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
  /** Owner connection — DDL rights, used only for migrations. */
  migrationUrl: string;
  /** Unprivileged application connection, subject to RLS. */
  appUrl: string;
}

/** Matches docker-compose, so a developer sees the same names either way. */
const DATABASE = 'forge';
const OWNER = 'forge';
const OWNER_PASSWORD = 'forge';

export async function startInfrastructure(): Promise<TestInfrastructure> {
  // Pinned to the same versions docker-compose runs. A test suite passing on
  // Postgres 17 while production runs 16 proves less than it appears to.
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase(DATABASE)
      .withUsername(OWNER)
      .withPassword(OWNER_PASSWORD)
      .start(),
    new RedisContainer('redis:7-alpine')
      // Append-only persistence, as in compose. The chaos test restarts this
      // container and expects queued jobs to still be there.
      .withCommand(['redis-server', '--appendonly', 'yes'])
      .start(),
  ]);

  // Built from the container's own host and port rather than patched from
  // `getConnectionUri()`, which returns a `postgres://` scheme — the env schema
  // requires `postgresql://`, and string-replacing one prefix into the other is
  // the kind of thing that works until Testcontainers changes its format.
  const host = postgres.getHost();
  const port = postgres.getPort();
  const url = (user: string, password: string) =>
    `postgresql://${user}:${password}@${host}:${port}/${DATABASE}?schema=public`;

  return {
    postgres,
    redis,
    migrationUrl: url(OWNER, OWNER_PASSWORD),
    // The application connects as `forge_app`, created by the RLS migration.
    // Connecting as the owner would bypass every tenant-isolation policy —
    // Postgres exempts superusers from RLS — so the isolation tests would pass
    // against a database where isolation was switched off.
    appUrl: url('forge_app', 'forge_app'),
  };
}

/**
 * Applies migrations with the Prisma CLI.
 *
 * `migrate deploy`, not `db push`: this runs the *same* migration files as
 * production, including the hand-written RLS policies and the `forge_app`
 * role. `db push` would diff the schema and silently skip every line of SQL
 * that Prisma did not generate — which is all of the security.
 */
export function applyMigrations(migrationUrl: string): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: {
      ...process.env,
      DATABASE_MIGRATION_URL: migrationUrl,
      DATABASE_URL: migrationUrl,
    },
    stdio: 'pipe',
  });
}

export async function stopInfrastructure(
  infrastructure: TestInfrastructure,
): Promise<void> {
  await Promise.all([
    infrastructure.postgres.stop(),
    infrastructure.redis.stop(),
  ]);
}
