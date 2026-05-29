-- Task #746: Drop the now-redundant global keyset indexes to speed up writes.
--
-- Migration 0071 added global `(created_at DESC, id DESC)` indexes
-- (`leads_created_at_id_idx`, `jobs_created_at_id_idx`,
-- `attribution_events_created_at_id_idx`). Migration 0072 then added
-- tenant-scoped `(tenant_id, created_at DESC, id DESC)` indexes.
--
-- Every real list query on these three tables filters by `tenant_id`: the
-- `/leads`, `/jobs`, and `/attribution/events` list endpoints plus the
-- `/drilldown/*` endpoints are all gated by `resolveListTenantScope`, and the
-- web UI requires a specific tenant to be selected before fetching (agency /
-- super_admin "All Tenants" mode shows a "Select a tenant" prompt instead of
-- issuing a cross-tenant query). Every service/cron query on these tables also
-- filters by `tenant_id`. The tenant-scoped indexes from 0072 fully serve all
-- of those queries with an Index Scan and no Sort (verified with EXPLAIN
-- ANALYZE for offset 0, deep offsets, and date-range bounds).
--
-- The only path that used the global indexes was a cross-tenant ordering with
-- no `tenant_id` filter (super_admin/agency calling the API without a
-- tenantId), which the product never triggers. Keeping these indexes only slows
-- every INSERT/UPDATE on the three highest-write tables and wastes disk, so we
-- drop them.
--
-- Idempotent: DROP INDEX IF EXISTS so re-running on a partially-patched
-- database is a no-op.

DROP INDEX IF EXISTS "leads_created_at_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "jobs_created_at_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "attribution_events_created_at_id_idx";
