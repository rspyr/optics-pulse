-- Task #436 — Subdomain → Funnel mapping.
--
-- Tenant-level rule that maps a request page_url's subdomain (e.g. `protect`
-- from `protect.advantageheatingllc.com`) to a specific funnel_type. Used by
-- the tracker ingestion waterfall after field/alias/url-path matching and
-- before the tenant-default fallback. Mirrors the shape of `funnel_aliases`.

CREATE TABLE IF NOT EXISTS "subdomain_funnel_rules" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "funnel_type_id" integer NOT NULL REFERENCES "funnel_types"("id") ON DELETE CASCADE,
  "subdomain" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_tenant_subdomain_funnel"
  ON "subdomain_funnel_rules" ("tenant_id", "subdomain");
