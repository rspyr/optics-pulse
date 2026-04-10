CREATE TABLE IF NOT EXISTS "sold_estimates" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "lead_id" integer REFERENCES "leads"("id"),
  "job_id" integer REFERENCES "jobs"("id"),
  "st_estimate_id" text NOT NULL,
  "st_job_id" text,
  "sold_by_name" text,
  "sold_by_st_employee_id" integer,
  "sold_on" timestamp,
  "subtotal" real DEFAULT 0,
  "rebate_amount" real DEFAULT 0,
  "total_amount" real DEFAULT 0,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_sold_estimates_tenant_st_id" ON "sold_estimates" ("tenant_id", "st_estimate_id");

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "has_sold_estimate" boolean DEFAULT false;
