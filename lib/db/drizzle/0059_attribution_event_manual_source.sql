-- Stamp how the operator resolved a manually-matched attribution event
-- (e.g. `field_mapping_rule:123` or `funnel_override:lead/555`) so the
-- event sheet can surface "MANUAL — resolved by …" with a deep-link
-- back to the action, instead of forcing the operator to dig through
-- audit logs to figure out which save flipped the row. See task #584.
--
-- Nullable: legacy `manual` rows written before this migration stay
-- null and render as MANUAL with no source attribution (matches the
-- pre-task behaviour). Cleared back to null by the existing revert path.
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "manual_source" text;
