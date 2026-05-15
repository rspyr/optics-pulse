-- Task #427 — checked-in migration for the `lead_status_history` audit table
-- introduced in task #416.
--
-- The table + indexes were originally created by the one-time migration
-- `2026-05-15_create-lead-status-history` in
-- `artifacts/api-server/src/services/one-time-migrations.ts`. That runner only
-- fires from a booted api-server, so any environment that hadn't started the
-- server yet (fresh dev DBs, test containers, ephemeral CI databases) was
-- missing the table and integration tests blew up with "relation
-- lead_status_history does not exist".
--
-- Promoting the DDL into a numbered SQL migration lets the
-- `runSchemaMigrations()` runner (see
-- `artifacts/api-server/src/services/schema-migrations.ts`) and any future
-- `drizzle-kit push`-based bootstrap apply it everywhere the schema is
-- materialised — without coupling it to api-server boot.
--
-- Fully idempotent: every statement uses `IF NOT EXISTS`, so environments
-- where the one-time migration already created the table (prod, the patched
-- dev DB) treat this as a no-op.

CREATE TABLE IF NOT EXISTS "lead_status_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "lead_id" integer NOT NULL,
  "tenant_id" integer NOT NULL,
  "from_status" text,
  "to_status" text NOT NULL,
  "changed_at" timestamp DEFAULT now() NOT NULL,
  "changed_by_user_id" integer,
  "reason" text,
  CONSTRAINT "lead_status_history_lead_id_leads_id_fk"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_status_history_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "lead_status_history_changed_by_user_id_users_id_fk"
    FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id")
);

CREATE INDEX IF NOT EXISTS "lead_status_history_lead_idx"
  ON "lead_status_history" ("lead_id", "changed_at");
CREATE INDEX IF NOT EXISTS "lead_status_history_to_status_idx"
  ON "lead_status_history" ("to_status", "changed_at");
CREATE INDEX IF NOT EXISTS "lead_status_history_tenant_idx"
  ON "lead_status_history" ("tenant_id", "changed_at");
