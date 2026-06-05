-- migration:no-transaction
-- These indexes cover the large existing tables that the challenge run
-- comparison endpoint scans. They are built with CREATE INDEX CONCURRENTLY so
-- the deploy does NOT take a write-blocking lock on leads/jobs/sold_estimates.
-- CONCURRENTLY cannot run inside a transaction, so this migration is flagged
-- no-transaction and each statement is its own breakpoint chunk. A DROP ... IF
-- EXISTS precedes each build so that if a previous CONCURRENTLY build was
-- interrupted (leaving an INVALID index), the retry rebuilds it cleanly instead
-- of skipping it via IF NOT EXISTS.
DROP INDEX CONCURRENTLY IF EXISTS leads_challenge_tenant_funnel_created_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS leads_challenge_tenant_funnel_created_idx ON leads(tenant_id, funnel_id, created_at);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS leads_challenge_tenant_lead_type_created_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS leads_challenge_tenant_lead_type_created_idx ON leads(tenant_id, LOWER(TRIM(lead_type)), created_at)
  WHERE funnel_id IS NULL AND lead_type IS NOT NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS jobs_challenge_tenant_lead_status_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_challenge_tenant_lead_status_idx ON jobs(tenant_id, lead_id, status);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS sold_estimates_challenge_tenant_lead_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS sold_estimates_challenge_tenant_lead_idx ON sold_estimates(tenant_id, lead_id);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS sold_estimates_challenge_tenant_job_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS sold_estimates_challenge_tenant_job_idx ON sold_estimates(tenant_id, job_id);
