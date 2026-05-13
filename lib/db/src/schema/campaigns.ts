import { pgTable, serial, integer, text, timestamp, real, date, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const campaignsTable = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  platform: text("platform").notNull(),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  currency: text("currency"),
  metaAdAccountId: text("meta_ad_account_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const campaignDailyStatsTable = pgTable("campaign_daily_stats", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id),
  date: date("date").notNull(),
  spend: real("spend").notNull().default(0),
  impressions: integer("impressions").notNull().default(0),
  clicks: integer("clicks").notNull().default(0),
  conversions: integer("conversions").notNull().default(0),
  actionsJson: jsonb("actions_json"),
  currency: text("currency"),
});

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({ id: true, createdAt: true });
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;

export const insertCampaignDailyStatSchema = createInsertSchema(campaignDailyStatsTable).omit({ id: true });
export type InsertCampaignDailyStat = z.infer<typeof insertCampaignDailyStatSchema>;
export type CampaignDailyStat = typeof campaignDailyStatsTable.$inferSelect;
