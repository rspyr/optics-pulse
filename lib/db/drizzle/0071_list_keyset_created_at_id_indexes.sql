-- Task #742: Make large list pages load instantly with a database index.
--
-- The hot list endpoints (`/leads`, `/jobs`, `/attribution/events`) use keyset
-- (cursor) pagination with a stable ordering of `ORDER BY created_at DESC, id DESC`.
-- Until now the `created_at` columns these queries seek on had no supporting
-- index, so every page request forced the planner to scan + sort the whole
-- table. These composite b-tree indexes are built in the same (created_at DESC,
-- id DESC) order as the queries, so the planner can satisfy both the seek
-- predicate and the ORDER BY from an index scan alone — no extra sort — which
-- keeps page latency flat as the tables grow.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS so re-running on a partially-patched
-- database is a no-op.

CREATE INDEX IF NOT EXISTS "leads_created_at_id_idx"
  ON "leads" ("created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_created_at_id_idx"
  ON "jobs" ("created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attribution_events_created_at_id_idx"
  ON "attribution_events" ("created_at" DESC, "id" DESC);
