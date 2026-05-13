-- Surface Meta ad creative metadata (thumbnail, headline, primary text) on the
-- ad-level breakdown so operators can scan creatives without leaving the app.
-- Idempotent.

ALTER TABLE "meta_ads"
  ADD COLUMN IF NOT EXISTS "creative_thumbnail_url" text,
  ADD COLUMN IF NOT EXISTS "creative_title" text,
  ADD COLUMN IF NOT EXISTS "creative_body" text;
