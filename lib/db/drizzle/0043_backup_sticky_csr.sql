ALTER TABLE "routing_config" ADD COLUMN IF NOT EXISTS "backup_sticky_csr_id" integer REFERENCES "users"("id");
