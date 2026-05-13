import { pgTable, serial, integer, text, boolean, timestamp, real, date, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const metaAdAccountsTable = pgTable("meta_ad_accounts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  accountId: text("account_id").notNull(),
  name: text("name").notNull().default(""),
  currency: text("currency").notNull().default("USD"),
  isSelected: boolean("is_selected").notNull().default(false),
  discoveredAt: timestamp("discovered_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantAccountUq: uniqueIndex("meta_ad_accounts_tenant_account_uq").on(t.tenantId, t.accountId),
}));

export const metaAdSetsTable = pgTable("meta_ad_sets", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  adAccountId: text("ad_account_id").notNull(),
  externalId: text("external_id").notNull(),
  campaignExternalId: text("campaign_external_id"),
  name: text("name").notNull().default(""),
  effectiveStatus: text("effective_status"),
  dailyBudgetCents: integer("daily_budget_cents"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantExternalUq: uniqueIndex("meta_ad_sets_tenant_external_uq").on(t.tenantId, t.externalId),
}));

export const metaAdsTable = pgTable("meta_ads", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  adAccountId: text("ad_account_id").notNull(),
  externalId: text("external_id").notNull(),
  adSetExternalId: text("ad_set_external_id"),
  campaignExternalId: text("campaign_external_id"),
  name: text("name").notNull().default(""),
  effectiveStatus: text("effective_status"),
  creativeId: text("creative_id"),
  creativeThumbnailUrl: text("creative_thumbnail_url"),
  creativeTitle: text("creative_title"),
  creativeBody: text("creative_body"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  tenantExternalUq: uniqueIndex("meta_ads_tenant_external_uq").on(t.tenantId, t.externalId),
}));

export const metaAdDailyStatsTable = pgTable("meta_ad_daily_stats", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  adAccountId: text("ad_account_id").notNull(),
  adExternalId: text("ad_external_id").notNull(),
  campaignExternalId: text("campaign_external_id"),
  adSetExternalId: text("ad_set_external_id"),
  date: date("date").notNull(),
  spend: real("spend").notNull().default(0),
  impressions: integer("impressions").notNull().default(0),
  clicks: integer("clicks").notNull().default(0),
  conversions: integer("conversions").notNull().default(0),
  currency: text("currency"),
  actionsJson: jsonb("actions_json"),
}, (t) => ({
  uq: uniqueIndex("meta_ad_daily_stats_uq").on(t.tenantId, t.adExternalId, t.date),
}));

export type MetaAdAccount = typeof metaAdAccountsTable.$inferSelect;
export type MetaAdSet = typeof metaAdSetsTable.$inferSelect;
export type MetaAd = typeof metaAdsTable.$inferSelect;
export type MetaAdDailyStat = typeof metaAdDailyStatsTable.$inferSelect;
