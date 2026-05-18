-- Task #448 — Persist dismissed subdomain suggestions per (tenant, user).
--
-- The Attribution page surfaces "Suggested subdomain rules" derived from
-- historical attribution events. Dismissals previously lived in component
-- state and reset on refresh; this table makes them durable per operator
-- without leaking one user's choices to the rest of the tenant.

CREATE TABLE IF NOT EXISTS "subdomain_suggestion_dismissals" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "subdomain" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_tenant_user_subdomain_dismissal"
  ON "subdomain_suggestion_dismissals" ("tenant_id", "user_id", "subdomain");
