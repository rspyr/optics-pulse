-- Task: Speed up phone lookups on large lead tables.
--
-- The forgiving phone matcher in `phone-utils.ts` (`phoneMatchesSql`) compares
-- the stored `leads.phone` after normalizing it through
-- `regexp_replace(... '[^0-9]', '', 'g')` plus a CASE that strips a leading
-- country-code "1" on 11-digit numbers. Wrapping the column in those
-- expressions disables any plain index on `phone`, so webhook,
-- reconciliation, callrail and unrouted-sheet-row lookups fall back to a
-- sequential scan once a tenant accumulates many leads.
--
-- This adds a composite expression index `(tenant_id, normalized_phone)`
-- mirroring `normalizedPhoneSql(leads.phone)` exactly. All callers already
-- filter by `tenant_id` first, so a tenant-scoped index keeps lookups O(log n)
-- per tenant. The CASE/regexp_replace/substring/length functions are all
-- IMMUTABLE in PostgreSQL, which is what makes this expression indexable.
--
-- Partial on `phone IS NOT NULL` to keep the index slim (null-phone leads are
-- never matched by the predicate anyway).
CREATE INDEX IF NOT EXISTS "leads_tenant_normalized_phone_idx"
  ON "leads" (
    "tenant_id",
    (CASE
      WHEN LENGTH(regexp_replace("phone", '[^0-9]', '', 'g')) = 11
        AND regexp_replace("phone", '[^0-9]', '', 'g') LIKE '1%'
      THEN SUBSTRING(regexp_replace("phone", '[^0-9]', '', 'g') FROM 2)
      ELSE regexp_replace("phone", '[^0-9]', '', 'g')
    END)
  )
  WHERE "phone" IS NOT NULL;
