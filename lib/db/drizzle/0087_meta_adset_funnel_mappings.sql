-- Add Meta ad-set funnel mappings and campaign/ad-set text match codes.
-- Existing campaign mappings remain valid; new rows with ad_set_external_id
-- can override a campaign-level mapping for one Meta ad set.

ALTER TABLE "campaign_funnel_mappings"
  ADD COLUMN IF NOT EXISTS "ad_set_external_id" text;

DROP INDEX IF EXISTS "campaign_funnel_mappings_campaign_id_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "campaign_funnel_mappings_campaign_level_idx"
  ON "campaign_funnel_mappings" ("campaign_id")
  WHERE "ad_set_external_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "campaign_funnel_mappings_ad_set_level_idx"
  ON "campaign_funnel_mappings" ("tenant_id", "campaign_id", "ad_set_external_id")
  WHERE "ad_set_external_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "campaign_funnel_mappings_tenant_ad_set_idx"
  ON "campaign_funnel_mappings" ("tenant_id", "ad_set_external_id");

CREATE TABLE IF NOT EXISTS "campaign_funnel_match_codes" (
  "id" serial PRIMARY KEY,
  "funnel_type_id" integer NOT NULL REFERENCES "funnel_types"("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "created_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "campaign_funnel_match_codes_code_idx"
  ON "campaign_funnel_match_codes" (lower("code"));

CREATE INDEX IF NOT EXISTS "campaign_funnel_match_codes_funnel_idx"
  ON "campaign_funnel_match_codes" ("funnel_type_id");
