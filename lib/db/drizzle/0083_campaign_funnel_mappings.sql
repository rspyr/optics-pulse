CREATE TABLE IF NOT EXISTS "campaign_funnel_mappings" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "campaign_id" integer NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "funnel_type_id" integer NOT NULL REFERENCES "funnel_types"("id") ON DELETE CASCADE,
  "mapping_source" text NOT NULL DEFAULT 'manual',
  "created_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "campaign_funnel_mappings_campaign_id_idx"
  ON "campaign_funnel_mappings" ("campaign_id");

CREATE INDEX IF NOT EXISTS "campaign_funnel_mappings_tenant_id_idx"
  ON "campaign_funnel_mappings" ("tenant_id");

CREATE INDEX IF NOT EXISTS "campaign_funnel_mappings_tenant_funnel_idx"
  ON "campaign_funnel_mappings" ("tenant_id", "funnel_type_id");
