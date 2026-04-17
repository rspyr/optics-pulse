CREATE TABLE IF NOT EXISTS "callrail_webhook_status" (
  "tenant_id" integer PRIMARY KEY NOT NULL,
  "last_success_at" timestamp,
  "last_failure_at" timestamp,
  "last_failure_reason" text,
  "last_call_id" text,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "callrail_webhook_status" ADD CONSTRAINT "callrail_webhook_status_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
