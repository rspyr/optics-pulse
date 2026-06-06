-- migration:no-transaction
-- Replace the functional-expression index on leads created in 0085
-- (`leads_challenge_tenant_lead_type_created_idx` keyed on
-- LOWER(TRIM(lead_type))) with a plain-column partial index.
--
-- WHY: Replit's Publish flow diffs the development database against production
-- with drizzle-kit. drizzle-kit's introspection cannot round-trip functional /
-- expression index keys -- it emits them verbatim with mis-assigned btree
-- operator classes (e.g. `tenant_id text_ops, lower(TRIM(BOTH FROM lead_type))
-- timestamp_ops`). Postgres then rejects the generated CREATE INDEX with
-- "operator class \"text_ops\" does not accept data type integer", failing the
-- publish migration validation. Plain-column indexes are normalized by the diff
-- and apply cleanly, so we drop the expression from the index key.
--
-- The challenge run-comparison query (dashboard.ts) joins the funnel_id-null
-- branch (`funnel_id IS NULL AND lead_type IS NOT NULL AND
-- LOWER(TRIM(lead_type)) = LOWER(TRIM(funnel_name))`) bounded by created_at per
-- tenant. The plain partial index below restricts the scan to that subset per
-- tenant ordered by created_at; the normalized lead_type equality is applied as
-- a residual filter on the (small) funnel_id-null cohort.
--
-- CONCURRENTLY cannot run inside a transaction, so this migration is flagged
-- no-transaction and each statement is its own breakpoint chunk. Each build is
-- preceded by a DROP ... IF EXISTS so an interrupted CONCURRENTLY build (which
-- leaves an INVALID index) is rebuilt cleanly on retry instead of skipped.
DROP INDEX CONCURRENTLY IF EXISTS leads_challenge_tenant_lead_type_created_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS leads_challenge_tenant_lead_type_created_idx ON leads(tenant_id, created_at)
  WHERE funnel_id IS NULL AND lead_type IS NOT NULL;
