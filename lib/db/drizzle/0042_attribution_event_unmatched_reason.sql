-- Persist the computed "why unmatched?" reason on each attribution event
-- row at write time so historical audits and old screenshots keep showing
-- the explanation the event was originally classified with, even if the
-- heuristic (computeUnmatchedReason in artifacts/api-server/src/routes/
-- tracker.ts) is reworded later.
--
-- Nullable: matched events leave this null, and legacy rows written
-- before this migration also stay null. The /attribution/events/:id
-- handler falls back to recomputing on read for null rows so we don't
-- need a destructive backfill.

ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "unmatched_reason" text;
