import { pgTable, integer, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { funnelTypesTable } from "./funnel-types";

export const tenantFunnelTypesTable = pgTable("tenant_funnel_types", {
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  funnelTypeId: integer("funnel_type_id").notNull().references(() => funnelTypesTable.id, { onDelete: "cascade" }),
  googleSheetId: text("google_sheet_id"),
  googleSheetTab: text("google_sheet_tab"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.funnelTypeId] }),
]);
