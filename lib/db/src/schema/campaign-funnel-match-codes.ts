import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { funnelTypesTable } from "./funnel-types";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const campaignFunnelMatchCodesTable = pgTable("campaign_funnel_match_codes", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  funnelTypeId: integer("funnel_type_id").notNull().references(() => funnelTypesTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("campaign_funnel_match_codes_tenant_idx").on(table.tenantId),
  index("campaign_funnel_match_codes_tenant_funnel_idx").on(table.tenantId, table.funnelTypeId),
]);

export type CampaignFunnelMatchCode = typeof campaignFunnelMatchCodesTable.$inferSelect;
