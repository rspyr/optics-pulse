-- Promote campaign/ad-set funnel match codes from tenant-specific to global.
-- Manual campaign/ad-set mappings remain tenant-specific in campaign_funnel_mappings.

DROP INDEX IF EXISTS "campaign_funnel_match_codes_tenant_code_idx";
DROP INDEX IF EXISTS "campaign_funnel_match_codes_tenant_idx";
DROP INDEX IF EXISTS "campaign_funnel_match_codes_tenant_funnel_idx";

WITH ranked_codes AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY lower(trim(code))
      ORDER BY updated_at DESC, id DESC
    ) AS rank
  FROM "campaign_funnel_match_codes"
)
DELETE FROM "campaign_funnel_match_codes" code
USING ranked_codes ranked
WHERE code.id = ranked.id
  AND ranked.rank > 1;

ALTER TABLE "campaign_funnel_match_codes"
  DROP COLUMN IF EXISTS "tenant_id";

CREATE UNIQUE INDEX IF NOT EXISTS "campaign_funnel_match_codes_code_idx"
  ON "campaign_funnel_match_codes" (lower("code"));

CREATE INDEX IF NOT EXISTS "campaign_funnel_match_codes_funnel_idx"
  ON "campaign_funnel_match_codes" ("funnel_type_id");
