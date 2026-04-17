-- Dedupe any pre-existing duplicates so the unique index can be created safely.
-- Keeps the lowest-id row per (tenant_id, external_id) pair.
DELETE FROM "attribution_events"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT "id",
           ROW_NUMBER() OVER (PARTITION BY "tenant_id", "external_id" ORDER BY "id") AS rn
    FROM "attribution_events"
    WHERE "external_id" IS NOT NULL
  ) ranked
  WHERE ranked.rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attribution_events_tenant_external_id_unique"
  ON "attribution_events" ("tenant_id", "external_id");
