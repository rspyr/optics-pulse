-- Add an optional deep-link CTA to notifications so alerts can take the
-- operator straight to the thing that needs fixing (e.g. the Re-analyze
-- button on a specific sheet config) instead of describing the path in
-- prose. Nullable: existing notifications stay link-less and render as
-- plain text exactly as before.
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "action_url" text;
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "action_label" text;
