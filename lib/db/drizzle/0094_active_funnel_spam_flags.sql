ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "is_spam" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "spam_reason" text;
--> statement-breakpoint
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "is_spam" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "spam_reason" text;
--> statement-breakpoint
ALTER TABLE "campaign_funnel_mappings" ADD COLUMN IF NOT EXISTS "mapping_mode" text NOT NULL DEFAULT 'funnel';
--> statement-breakpoint
ALTER TABLE "campaign_funnel_match_codes" ADD COLUMN IF NOT EXISTS "mapping_mode" text NOT NULL DEFAULT 'funnel';
--> statement-breakpoint
ALTER TABLE "campaign_funnel_mappings" ALTER COLUMN "funnel_type_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "campaign_funnel_match_codes" ALTER COLUMN "funnel_type_id" DROP NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaign_funnel_mappings_mapping_mode_check'
  ) THEN
    ALTER TABLE "campaign_funnel_mappings"
      ADD CONSTRAINT "campaign_funnel_mappings_mapping_mode_check"
      CHECK (
        ("mapping_mode" = 'funnel' AND "funnel_type_id" IS NOT NULL)
        OR ("mapping_mode" = 'active_funnel' AND "funnel_type_id" IS NULL)
      );
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaign_funnel_match_codes_mapping_mode_check'
  ) THEN
    ALTER TABLE "campaign_funnel_match_codes"
      ADD CONSTRAINT "campaign_funnel_match_codes_mapping_mode_check"
      CHECK (
        ("mapping_mode" = 'funnel' AND "funnel_type_id" IS NOT NULL)
        OR ("mapping_mode" = 'active_funnel' AND "funnel_type_id" IS NULL)
      );
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_tenant_not_spam_idx" ON "leads" ("tenant_id", "created_at" DESC) WHERE "is_spam" IS NOT TRUE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attribution_events_tenant_not_spam_idx" ON "attribution_events" ("tenant_id", "created_at" DESC) WHERE "is_spam" IS NOT TRUE;
--> statement-breakpoint
UPDATE "leads"
SET
  "is_spam" = true,
  "spam_reason" = COALESCE("spam_reason", 'Known junk name or empty unknown/no-phone lead')
WHERE "is_spam" IS NOT TRUE
  AND (
    LOWER(TRIM(CONCAT_WS(' ', COALESCE("first_name", ''), COALESCE("last_name", '')))) IN ('john doe', 'jane doe', 'fsgsfd gfds')
    OR (
      LOWER(TRIM(COALESCE("first_name", ''))) = 'unknown'
      AND COALESCE(NULLIF(REGEXP_REPLACE(COALESCE("phone", ''), '[^0-9]', '', 'g'), ''), '') = ''
    )
  );
--> statement-breakpoint
UPDATE "attribution_events" ae
SET
  "is_spam" = true,
  "spam_reason" = COALESCE(ae."spam_reason", l."spam_reason", 'Linked lead was marked spam')
FROM "leads" l
WHERE ae."created_lead_id" = l."id"
  AND l."is_spam" IS TRUE
  AND ae."is_spam" IS NOT TRUE;
--> statement-breakpoint
UPDATE "attribution_events"
SET
  "is_spam" = true,
  "spam_reason" = COALESCE("spam_reason", 'Known junk form payload')
WHERE "is_spam" IS NOT TRUE
  AND (
    LOWER(COALESCE("form_fields"::text, '')) LIKE '%john doe%'
    OR LOWER(COALESCE("form_fields"::text, '')) LIKE '%fsgsfd gfds%'
    OR (
      LOWER(COALESCE("form_fields"::text, '')) LIKE '%unknown%'
      AND "hashed_phone" IS NULL
    )
  );
