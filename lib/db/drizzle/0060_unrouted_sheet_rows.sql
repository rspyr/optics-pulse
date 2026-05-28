CREATE TABLE IF NOT EXISTS "unrouted_sheet_rows" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL,
  "sheet_config_id" integer NOT NULL,
  "funnel_column" text,
  "unmatched_value" text,
  "row_data" jsonb NOT NULL,
  "reason" text DEFAULT 'no_funnel_match' NOT NULL,
  "source" text DEFAULT 'sheet_sync' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "resolved_at" timestamp,
  "resolved_by_user_id" integer
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "unrouted_sheet_rows" ADD CONSTRAINT "unrouted_sheet_rows_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "unrouted_sheet_rows" ADD CONSTRAINT "unrouted_sheet_rows_sheet_config_id_google_sheet_configs_id_fk"
    FOREIGN KEY ("sheet_config_id") REFERENCES "google_sheet_configs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unrouted_sheet_rows_config_unresolved_idx" ON "unrouted_sheet_rows" ("sheet_config_id", "resolved_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unrouted_sheet_rows_tenant_idx" ON "unrouted_sheet_rows" ("tenant_id");
