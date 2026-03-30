ALTER TABLE "routing_config" ADD COLUMN IF NOT EXISTS "sticky_after_cascade" boolean DEFAULT false NOT NULL;
ALTER TABLE "routing_config" ADD COLUMN IF NOT EXISTS "sticky_csr_id" integer REFERENCES "users"("id");
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "cascade_pass_count" integer DEFAULT 0 NOT NULL;
