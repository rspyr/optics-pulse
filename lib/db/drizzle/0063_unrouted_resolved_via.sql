-- Track whether resolving an unrouted row created a brand-new lead or
-- re-submitted to a pre-existing one. Source of truth for whether a
-- recent re-route is safe to undo: only `new_lead` resolutions are
-- undoable; resubmissions point at history we must not destroy.
ALTER TABLE "unrouted_sheet_rows"
  ADD COLUMN IF NOT EXISTS "resolved_via" text;
