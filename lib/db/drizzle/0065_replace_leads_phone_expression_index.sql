-- Replace the legacy expression index on leads.phone with a plain
-- composite b-tree index on (tenant_id, phone).
--
-- Background: migration 0064 originally created
-- `leads_tenant_normalized_phone_idx` as an expression index over
-- `CASE WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 11 ... END`
-- to match the read-time `normalizedPhoneSql` wrapper from `phone-utils.ts`.
--
-- Task #639 removed that wrapper: phones are now stored canonically
-- (digits-only, leading "1" stripped) via the `normalize-leads-phone`
-- one-time backfill plus on-write normalization, and every call site
-- does a plain `eq(leads.phone, normalizePhone(input))`. A plain
-- `(tenant_id, phone)` index is sufficient for all those lookups.
--
-- The legacy expression index is also actively harmful: drizzle-kit's
-- schema-diff / migration-proposal tooling round-trips it through pg
-- introspection and emits malformed DDL (CASE truncated, `int4_ops`
-- injected mid-expression, stray `WHERE`) that fails to parse. Dropping
-- it removes that footgun for anyone running `drizzle-kit push` or the
-- Replit migration proposal UI against this DB.
--
-- 0064 was rewritten to do this same drop+create for fresh databases,
-- but the api-server migration runner skips files whose tag is already
-- in `_applied_migrations`, so existing DBs (dev, staging, prod) need
-- this separate migration to actually run the change.

DROP INDEX IF EXISTS "leads_tenant_normalized_phone_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_tenant_phone_idx"
  ON "leads" ("tenant_id", "phone")
  WHERE "phone" IS NOT NULL;
