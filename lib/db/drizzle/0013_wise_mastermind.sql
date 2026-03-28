CREATE TYPE "public"."hub_status_enum" AS ENUM('day_1', 'day_2', 'day_3', 'day_4', 'day_5_old', 'appt_set', 'call_back', 'dead');--> statement-breakpoint
ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_hub_status_check";--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "hub_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "hub_status" SET DATA TYPE "public"."hub_status_enum" USING "hub_status"::"public"."hub_status_enum";--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "hub_status" SET DEFAULT 'day_1'::"public"."hub_status_enum";