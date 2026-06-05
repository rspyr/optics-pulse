import { pgTable, serial, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { campaignsTable } from "./campaigns";
import { funnelTypesTable } from "./funnel-types";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const campaignFunnelMappingsTable = pgTable("campaign_funnel_mappings", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  funnelTypeId: integer("funnel_type_id").notNull().references(() => funnelTypesTable.id, { onDelete: "cascade" }),
  mappingSource: text("mapping_source").notNull().default("manual"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  campaignUniqueIdx: uniqueIndex("campaign_funnel_mappings_campaign_id_idx").on(table.campaignId),
  tenantIdx: index("campaign_funnel_mappings_tenant_id_idx").on(table.tenantId),
  tenantFunnelIdx: index("campaign_funnel_mappings_tenant_funnel_idx").on(table.tenantId, table.funnelTypeId),
}));

export type CampaignFunnelMapping = typeof campaignFunnelMappingsTable.$inferSelect;
