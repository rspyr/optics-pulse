ALTER TABLE "jobs" ALTER COLUMN "customer_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "st_job_id_hash" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "st_data_expires_at" timestamp;