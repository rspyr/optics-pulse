-- Meta integration rebuild: shared-app OAuth, ad-account discovery,
-- per-ad daily insights, currency, reconnect signal.
-- Idempotent (uses IF NOT EXISTS).

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "meta_needs_reconnect" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "meta_reconnect_reason" text,
  ADD COLUMN IF NOT EXISTS "meta_last_synced_at" timestamp;

ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "currency" text,
  ADD COLUMN IF NOT EXISTS "meta_ad_account_id" text;

ALTER TABLE "campaign_daily_stats"
  ADD COLUMN IF NOT EXISTS "actions_json" jsonb,
  ADD COLUMN IF NOT EXISTS "currency" text;

CREATE TABLE IF NOT EXISTS "meta_ad_accounts" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "account_id" text NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "currency" text NOT NULL DEFAULT 'USD',
  "is_selected" boolean NOT NULL DEFAULT false,
  "discovered_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "meta_ad_accounts_tenant_account_uq"
  ON "meta_ad_accounts" ("tenant_id", "account_id");

CREATE TABLE IF NOT EXISTS "meta_ad_sets" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "ad_account_id" text NOT NULL,
  "external_id" text NOT NULL,
  "campaign_external_id" text,
  "name" text NOT NULL DEFAULT '',
  "effective_status" text,
  "daily_budget_cents" integer,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "meta_ad_sets_tenant_external_uq"
  ON "meta_ad_sets" ("tenant_id", "external_id");

CREATE TABLE IF NOT EXISTS "meta_ads" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "ad_account_id" text NOT NULL,
  "external_id" text NOT NULL,
  "ad_set_external_id" text,
  "campaign_external_id" text,
  "name" text NOT NULL DEFAULT '',
  "effective_status" text,
  "creative_id" text,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "meta_ads_tenant_external_uq"
  ON "meta_ads" ("tenant_id", "external_id");

CREATE TABLE IF NOT EXISTS "meta_ad_daily_stats" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "ad_account_id" text NOT NULL,
  "ad_external_id" text NOT NULL,
  "campaign_external_id" text,
  "ad_set_external_id" text,
  "date" date NOT NULL,
  "spend" real NOT NULL DEFAULT 0,
  "impressions" integer NOT NULL DEFAULT 0,
  "clicks" integer NOT NULL DEFAULT 0,
  "conversions" integer NOT NULL DEFAULT 0,
  "currency" text,
  "actions_json" jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS "meta_ad_daily_stats_uq"
  ON "meta_ad_daily_stats" ("tenant_id", "ad_external_id", "date");
