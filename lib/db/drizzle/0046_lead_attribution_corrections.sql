-- Audit trail for manager-driven Source/Funnel corrections that
-- propagate from the Attribution page (alias save) into denormalized
-- columns on `leads`. Each row captures one field-level change so the
-- Lead Hub can show a "Correction history" panel for client trust /
-- dispute resolution. Matches schema in
-- lib/db/src/schema/lead-attribution-corrections.ts.

CREATE TABLE IF NOT EXISTS "lead_attribution_corrections" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "lead_id" integer NOT NULL REFERENCES "leads"("id"),
  "field" text NOT NULL,
  "old_value" text,
  "new_value" text,
  "changed_by_user_id" integer REFERENCES "users"("id"),
  "source_alias_id" integer REFERENCES "lead_source_aliases"("id") ON DELETE SET NULL,
  "funnel_alias_id" integer REFERENCES "funnel_aliases"("id") ON DELETE SET NULL,
  "changed_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_lead_attr_corrections_lead"
  ON "lead_attribution_corrections" ("lead_id", "changed_at");
