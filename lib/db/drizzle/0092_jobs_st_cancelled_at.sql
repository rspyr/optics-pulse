-- migration:no-transaction
-- Meta Impact attribution:
-- Store ServiceTitan's cancellation-log timestamp so cancellation reporting
-- can use the actual status-change date instead of job origin or sync time.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "st_cancelled_at" timestamp;
--> statement-breakpoint

COMMENT ON COLUMN "jobs"."st_cancelled_at" IS 'ServiceTitan jobs/{id}/canceled-log createdOn timestamp. Used for outcome-window cancellation reporting.';
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "jobs_tenant_cancelled_idx";
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_tenant_cancelled_idx"
ON "jobs" ("tenant_id", "st_cancelled_at");
