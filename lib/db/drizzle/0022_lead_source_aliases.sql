CREATE TABLE IF NOT EXISTS "lead_source_aliases" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES "tenants"("id"),
  "canonical_name" TEXT NOT NULL,
  "alias" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_tenant_alias_lower" ON "lead_source_aliases" (tenant_id, (lower(alias)));
