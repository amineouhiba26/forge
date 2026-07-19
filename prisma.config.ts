import 'dotenv/config';

import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 CLI config.
 *
 * The schema no longer carries the connection URL, so the CLI reads it here
 * instead. Only migration/introspection commands use this file — the running
 * services build their own connection through the pg adapter in
 * `libs/prisma/src/prisma.service.ts`.
 */
export default defineConfig({
  schema: 'libs/prisma/prisma/schema.prisma',
  migrations: {
    path: 'libs/prisma/prisma/migrations',
  },
  datasource: {
    // Migrations need DDL rights and must not be subject to RLS, so they use
    // the owner connection — not the restricted role the services run as.
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL,
  },
});
