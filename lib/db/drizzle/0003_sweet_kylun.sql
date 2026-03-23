CREATE TABLE "coordinator_daily_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"date" date NOT NULL,
	"calls_made" integer DEFAULT 0 NOT NULL,
	"bookings_count" integer DEFAULT 0 NOT NULL,
	"booking_rate" real DEFAULT 0 NOT NULL,
	"commission" real DEFAULT 0 NOT NULL,
	"avg_speed_to_lead" real DEFAULT 0 NOT NULL,
	"sold_count" integer DEFAULT 0 NOT NULL,
	"new_leads_handled" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coordinator_daily_stats_user_date" UNIQUE("user_id","date")
);
--> statement-breakpoint
ALTER TABLE "coordinator_daily_stats" ADD CONSTRAINT "coordinator_daily_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;