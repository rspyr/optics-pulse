CREATE TABLE IF NOT EXISTS "background_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "run_at" timestamptz NOT NULL DEFAULT now(),
  "locked_at" timestamptz,
  "locked_by" text,
  "last_error" text,
  "result" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_jobs_status_run_at_idx"
  ON "background_jobs" ("status", "run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_jobs_type_status_idx"
  ON "background_jobs" ("type", "status");
