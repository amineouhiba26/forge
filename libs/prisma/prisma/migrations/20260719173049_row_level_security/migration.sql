-- Row-Level Security: tenant isolation enforced by Postgres itself.
--
-- The point is that a forgotten `WHERE tenant_id = ...` in application code
-- must not be able to leak another tenant's rows. Application-level filtering
-- is one bug away from a cross-tenant breach; a policy here is enforced on
-- every query no matter which code path issued it.

-- ---------------------------------------------------------------------------
-- The application role
-- ---------------------------------------------------------------------------
-- RLS does not apply to superusers, or to any role with BYPASSRLS. The
-- bootstrap role that owns these tables (`forge`, from docker-compose) is a
-- superuser, so if the services connected as it, every policy below would be
-- silently inert — the queries would succeed and return everything.
--
-- So the application connects as this separate, deliberately unprivileged
-- role. Migrations still run as the owner, which is why DATABASE_URL and
-- DATABASE_MIGRATION_URL are two different connection strings.
--
-- The password here is a local-development value; docker-compose exposes the
-- database on localhost only. A real deployment provisions this role from a
-- secret manager, and this CREATE becomes a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'forge_app') THEN
    CREATE ROLE forge_app WITH LOGIN PASSWORD 'forge_app';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO forge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forge_app;

-- Tables created by later migrations must be reachable too, without having to
-- remember a GRANT in every one of them.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO forge_app;

-- Note what is NOT granted: no DDL, no ownership, no BYPASSRLS. The
-- application cannot drop a policy it dislikes.

-- Reads the tenant set by `SET LOCAL app.current_tenant_id` for the current
-- transaction.
--
-- The `true` second argument makes `current_setting` return NULL instead of
-- raising when the setting is missing. `NULLIF(..., '')` then maps the empty
-- string to NULL as well. Both matter: with no tenant context every policy
-- comparison evaluates to NULL, which is not TRUE, so **no rows are visible**.
-- Failing closed is the entire point — an unset context must never mean "all".
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;

-- ENABLE alone is not enough: a table's owner bypasses RLS by default, and the
-- application connects as the owner. FORCE subjects the owner to policies too.
-- Without this line every policy below is silently inert.
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;

-- A tenant can only ever see itself.
CREATE POLICY tenant_isolation_select ON "tenants"
  FOR SELECT USING (id = current_tenant_id());

CREATE POLICY tenant_isolation_update ON "tenants"
  FOR UPDATE USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

CREATE POLICY tenant_isolation_delete ON "tenants"
  FOR DELETE USING (id = current_tenant_id());

-- INSERT is deliberately unrestricted, and it is the one hole that has to
-- exist: signup creates a tenant before any tenant context can exist. The
-- SELECT policy still applies immediately afterwards, so a caller cannot read
-- back anything it did not just create.
CREATE POLICY tenant_insert ON "tenants"
  FOR INSERT WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

-- USING filters which rows are visible to read/update/delete.
-- WITH CHECK validates rows being written — without it a tenant could INSERT a
-- row stamped with someone else's tenant_id, or UPDATE a row to move it out of
-- its own tenant. Both halves are required.
CREATE POLICY tenant_isolation ON "users"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- refresh_tokens
-- ---------------------------------------------------------------------------
ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "refresh_tokens"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
