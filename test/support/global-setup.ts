import { applyMigrations, startInfrastructure } from './containers';
import type { TestInfrastructure } from './containers';

/**
 * Runs once before the whole e2e suite.
 *
 * Starting the containers per *run* rather than per suite: each suite boots
 * five Nest applications already, and paying ~5s of container startup six
 * times over would triple the suite. Isolation between suites comes from
 * unique tenants, which RLS enforces anyway.
 *
 * The started containers are stashed on `globalThis` so teardown can stop them
 * — Jest gives global setup and teardown no other channel between them.
 */
export default async function globalSetup(): Promise<void> {
  const startedAt = Date.now();
  process.stdout.write('\n  Starting Postgres and Redis containers…');

  const infrastructure = await startInfrastructure();

  applyMigrations(infrastructure.migrationUrl);

  // Every suite reads these, and every service reads them at module-load time
  // via dotenv. Set here so no suite has to know where the database came from.
  process.env.DATABASE_URL = infrastructure.appUrl;
  process.env.DATABASE_MIGRATION_URL = infrastructure.migrationUrl;
  // Quiet by default: the services log a line per request, which buries the
  // test results in several hundred lines of noise. Respects an explicit
  // setting, so `LOG_LEVEL=info npm run test:e2e` restores them for debugging.
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';

  process.env.REDIS_HOST = infrastructure.redis.getHost();
  process.env.REDIS_PORT = String(infrastructure.redis.getPort());

  (globalThis as { __INFRA__?: TestInfrastructure }).__INFRA__ = infrastructure;

  process.stdout.write(` ready in ${Date.now() - startedAt}ms\n`);
}
