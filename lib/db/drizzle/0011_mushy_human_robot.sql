ALTER TABLE "attribution_events" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "script_versions" ADD COLUMN "disposition_filter" text;--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "disposition_filter" text;