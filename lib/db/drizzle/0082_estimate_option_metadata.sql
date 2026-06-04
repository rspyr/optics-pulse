-- Broaden the existing ServiceTitan estimate cache from sold-only contracts to
-- all active estimate options. Add-only and nullable so existing production
-- sold_estimates rows keep working during deploy.
ALTER TABLE "sold_estimates"
  ADD COLUMN IF NOT EXISTS "estimate_name" text,
  ADD COLUMN IF NOT EXISTS "estimate_status" text,
  ADD COLUMN IF NOT EXISTS "summary" text,
  ADD COLUMN IF NOT EXISTS "follow_up_on" timestamp;
