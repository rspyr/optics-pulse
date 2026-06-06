import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { campaignsTable } from "./campaigns";
import { funnelTypesTable } from "./funnel-types";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const campaignFunnelMappingsTable = pgTable("campaign_funnel_mappings", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  adSetExternalId: text("ad_set_external_id"),
  funnelTypeId: integer("funnel_type_id").notNull().references(() => funnelTypesTable.id, { onDelete: "cascade" }),
  mappingSource: text("mapping_source").notNull().default("manual"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("campaign_funnel_mappings_campaign_level_idx")
    .on(table.campaignId)
    .where(sql`ad_set_external_id IS NULL`),
  uniqueIndex("campaign_funnel_mappings_ad_set_level_idx")
    .on(table.tenantId, table.campaignId, table.adSetExternalId)
    .where(sql`ad_set_external_id IS NOT NULL`),
  index("campaign_funnel_mappings_tenant_id_idx").on(table.tenantId),
  index("campaign_funnel_mappings_tenant_funnel_idx").on(table.tenantId, table.funnelTypeId),
  index("campaign_funnel_mappings_tenant_ad_set_idx").on(table.tenantId, table.adSetExternalId),
]);

export type CampaignFunnelMapping = typeof campaignFunnelMappingsTable.$inferSelect;
