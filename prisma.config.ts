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
    url: process.env.DATABASE_URL,
  },
});
