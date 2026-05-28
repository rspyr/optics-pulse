-- Task: Speed up tenant-scoped phone lookups on the leads table.
--
-- History: this migration originally created an expression index over
-- `CASE WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 11 ... END`
-- to match the read-time `normalizedPhoneSql` wrapper from `phone-utils.ts`.
-- That wrapper has since been removed (task #639): phones are stored
-- canonically (digits-only, leading "1" stripped) by the 2026-05-28
-- `normalize-leads-phone` one-time migration plus on-write normalization,
-- and every call site now does a plain `eq(leads.phone, normalizePhone(input))`.
--
-- A plain composite b-tree index on `(tenant_id, phone)` is therefore
-- sufficient for all phone lookups (webhook, reconciliation, callrail,
-- unrouted-sheet-rows, leads-hub phone-match, lead search). The old
-- expression index was also tripping up drizzle-kit's schema-diff /
-- migration-proposal tooling, which mangled the CASE expression on
-- round-trip. Dropping it removes that footgun.
--
-- Partial on `phone IS NOT NULL` keeps the index slim — null-phone leads
-- are never matched by phone-equality predicates.

DROP INDEX IF EXISTS "leads_tenant_normalized_phone_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_tenant_phone_idx"
  ON "leads" ("tenant_id", "phone")
  WHERE "phone" IS NOT NULL;
