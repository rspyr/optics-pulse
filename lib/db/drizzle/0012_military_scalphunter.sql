CREATE TABLE "csr_schedule" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"pause_start" timestamp,
	"pause_end" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"funnel_type_id" integer,
	"cascade_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pass_interval_hours" integer DEFAULT 24 NOT NULL,
	"allow_pass_back" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "service_type" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "funnel_id" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "assigned_csr_id" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "hub_status" text DEFAULT 'day_1' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "day_in_sequence" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "contact_preferences" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "callback_at" timestamp;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "revisit_date" date;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "dead_reason" text;--> statement-breakpoint
ALTER TABLE "tenant_funnel_types" ADD COLUMN "google_sheet_id" text;--> statement-breakpoint
ALTER TABLE "tenant_funnel_types" ADD COLUMN "google_sheet_tab" text;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "action_type" text DEFAULT 'call' NOT NULL;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "call_result" text;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "vm_result" text;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "text_result" text;--> statement-breakpoint
ALTER TABLE "call_attempts" ADD COLUMN "dead_reason" text;--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "funnel_filter" text;--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "service_type_filter" text;--> statement-breakpoint
ALTER TABLE "csr_schedule" ADD CONSTRAINT "csr_schedule_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csr_schedule" ADD CONSTRAINT "csr_schedule_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_config" ADD CONSTRAINT "routing_config_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_config" ADD CONSTRAINT "routing_config_funnel_type_id_funnel_types_id_fk" FOREIGN KEY ("funnel_type_id") REFERENCES "public"."funnel_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_funnel_id_funnel_types_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnel_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_csr_id_users_id_fk" FOREIGN KEY ("assigned_csr_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;