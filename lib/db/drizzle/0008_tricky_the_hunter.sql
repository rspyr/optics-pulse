ALTER TABLE "tenants" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "st_customer_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "st_location_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "customer_phone" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "customer_email" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "job_type_name" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "business_unit" text;