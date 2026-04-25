CREATE TABLE IF NOT EXISTS "tracker_submit_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer,
	"client_id" text,
	"endpoint" text NOT NULL,
	"domain" text,
	"page_url" text,
	"user_agent" text,
	"outcome" text NOT NULL,
	"http_status" integer NOT NULL,
	"message" text,
	"pulse_version" text,
	"attribution_event_id" integer,
	"payload_sample" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tracker_submit_attempts" ADD CONSTRAINT "tracker_submit_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tracker_submit_attempts" ADD CONSTRAINT "tracker_submit_attempts_attribution_event_id_attribution_events_id_fk" FOREIGN KEY ("attribution_event_id") REFERENCES "public"."attribution_events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tsa_tenant_created_idx" ON "tracker_submit_attempts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tsa_domain_created_idx" ON "tracker_submit_attempts" USING btree ("domain","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tsa_outcome_idx" ON "tracker_submit_attempts" USING btree ("outcome");
