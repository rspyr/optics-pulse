import { pgTable, serial, text, boolean, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tenantsTable = pgTable("tenants", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  clientSlug: text("client_slug").notNull(),
  serviceTitanId: text("service_titan_id"),
  timezone: text("timezone").notNull().default("America/New_York"),
  apiConfig: jsonb("api_config"),
  alertConfig: jsonb("alert_config"),
  communicationConfig: jsonb("communication_config"),
  leaderboardConfig: jsonb("leaderboard_config"),
  revenueConfig: jsonb("revenue_config"),
  spiffConfig: jsonb("spiff_config"),
  oldLeadThreshold: integer("old_lead_threshold"),
  monthlyBudget: integer("monthly_budget"),
  isActive: boolean("is_active").notNull().default(true),
  isDemo: boolean("is_demo").notNull().default(false),
  stSyncPaused: boolean("st_sync_paused").notNull().default(true),
  stJobsSyncUtcMinuteOffset: integer("st_jobs_sync_utc_minute_offset").notNull().default(0),
  stRevenueSyncUtcMinuteOffset: integer("st_revenue_sync_utc_minute_offset").notNull().default(5),
  leadIngestionMode: text("lead_ingestion_mode").notNull().default("sheets"),
  metaNeedsReconnect: boolean("meta_needs_reconnect").notNull().default(false),
  metaReconnectReason: text("meta_reconnect_reason"),
  metaLastSyncedAt: timestamp("meta_last_synced_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;
