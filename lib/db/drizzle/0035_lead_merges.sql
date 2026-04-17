CREATE TABLE IF NOT EXISTS "lead_merges" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL,
  "duplicate_lead_id" integer NOT NULL,
  "canonical_lead_id" integer NOT NULL,
  "source" text NOT NULL,
  "run_id" text,
  "merged_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "lead_merges" ADD CONSTRAINT "lead_merges_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lead_merges_duplicate_lead_id_idx" ON "lead_merges" ("duplicate_lead_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_merges_canonical_lead_id_idx" ON "lead_merges" ("canonical_lead_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_merges_tenant_id_idx" ON "lead_merges" ("tenant_id");
