-- Task #836 — Route / page → Funnel mapping.
--
-- Tenant-level rule that maps a request page_url's normalized pathname (e.g.
-- `/summer-relief`) to a specific funnel_type. More specific than a subdomain
-- rule: used by the tracker ingestion waterfall after field/alias matching and
-- BEFORE the subdomain rule (route beats subdomain) and the tenant-default
-- fallback. Mirrors the shape of `subdomain_funnel_rules`.

CREATE TABLE IF NOT EXISTS "route_funnel_rules" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "funnel_type_id" integer NOT NULL REFERENCES "funnel_types"("id") ON DELETE CASCADE,
  "route_path" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_tenant_route_path_funnel"
  ON "route_funnel_rules" ("tenant_id", "route_path");

-- Per-(tenant, user) dismissals for suggested route rules, mirroring
-- subdomain_suggestion_dismissals.
CREATE TABLE IF NOT EXISTS "route_suggestion_dismissals" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "route_path" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_tenant_user_route_path_dismissal"
  ON "route_suggestion_dismissals" ("tenant_id", "user_id", "route_path");
