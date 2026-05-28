-- Task #651: Make rebate revenue programs configurable per tenant.
-- The hardcoded rebate label patterns (ETO, ODEE, Energy Trust) are now
-- DB-backed and editable from the integrations admin UI. This column stores
-- the per-tenant override as { "rebateLabels": string[] }; a missing/empty
-- list means "fall back to the seeded defaults" (handled in application code).
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "revenue_config" jsonb;
