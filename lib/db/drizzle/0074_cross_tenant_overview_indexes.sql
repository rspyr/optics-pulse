-- Task #751: Supporting indexes for the deliberate cross-tenant overview.
--
-- The implicit unfiltered cross-tenant *list* path (an unbounded
-- `ORDER BY created_at` over a whole base table) was closed off by the
-- `requireTenant` guard on the /leads, /jobs, /attribution/events and
-- /drilldown/* endpoints. The replacement for agencies that genuinely want a
-- roll-up across all their tenants is the purpose-built
-- `GET /dashboard/cross-tenant-overview` endpoint, which aggregates
-- per-tenant in single `GROUP BY tenant_id` queries over a bounded date range.
--
-- The lead/job sides of that aggregation are already served by the
-- tenant-scoped `(tenant_id, created_at DESC, id DESC)` indexes from migration
-- 0072. The spend side joins campaign_daily_stats -> campaigns and groups by
-- campaigns.tenant_id, which had no supporting index (only the two primary
-- keys), forcing a sequential scan of the whole stats table. These two indexes
-- close that gap:
--   * campaigns(tenant_id) so each tenant's campaigns resolve via an index
--     lookup instead of a seq scan.
--   * campaign_daily_stats(campaign_id, date) so each campaign's daily rows in
--     the requested window are range-scanned straight from the index.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS so re-running on a partially-patched
-- database is a no-op.

CREATE INDEX IF NOT EXISTS "campaigns_tenant_id_idx"
  ON "campaigns" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_daily_stats_campaign_id_date_idx"
  ON "campaign_daily_stats" ("campaign_id", "date");
