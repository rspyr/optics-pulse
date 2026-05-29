-- Task #745: Keep list pages fast even when filtered to one tenant/date range.
--
-- Task #742 (migration 0071) added `(created_at DESC, id DESC)` indexes that
-- speed up the *unfiltered* keyset-paged lists. But the real list endpoints
-- (`/leads`, `/jobs`, `/attribution/events`) always filter by `tenant_id`
-- (and `/leads` adds optional `created_at` date-range bounds). On a large
-- multi-tenant table the global `(created_at, id)` index still has to scan over
-- rows belonging to other tenants before collecting enough rows for the
-- requested tenant.
--
-- These tenant-scoped composite indexes lead with `tenant_id`, so the planner
-- can jump straight to one tenant's slice and still satisfy the keyset
-- `ORDER BY created_at DESC, id DESC` from the index alone — an Index Scan with
-- no Sort node, with or without a date range.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS so re-running on a partially-patched
-- database is a no-op.

CREATE INDEX IF NOT EXISTS "leads_tenant_created_at_id_idx"
  ON "leads" ("tenant_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_tenant_created_at_id_idx"
  ON "jobs" ("tenant_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attribution_events_tenant_created_at_id_idx"
  ON "attribution_events" ("tenant_id", "created_at" DESC, "id" DESC);
