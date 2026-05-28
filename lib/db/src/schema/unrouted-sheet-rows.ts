import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { googleSheetConfigsTable } from "./google-sheet-configs";

export const unroutedSheetRowsTable = pgTable("unrouted_sheet_rows", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  sheetConfigId: integer("sheet_config_id").notNull().references(() => googleSheetConfigsTable.id, { onDelete: "cascade" }),
  funnelColumn: text("funnel_column"),
  unmatchedValue: text("unmatched_value"),
  rowData: jsonb("row_data").notNull().$type<Record<string, string>>(),
  reason: text("reason").notNull().default("no_funnel_match"),
  source: text("source").notNull().default("sheet_sync"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
  resolvedByUserId: integer("resolved_by_user_id"),
  resolvedLeadId: integer("resolved_lead_id"),
}, (table) => ({
  byConfigUnresolved: index("unrouted_sheet_rows_config_unresolved_idx").on(table.sheetConfigId, table.resolvedAt),
  byTenant: index("unrouted_sheet_rows_tenant_idx").on(table.tenantId),
}));

export type UnroutedSheetRow = typeof unroutedSheetRowsTable.$inferSelect;
export type InsertUnroutedSheetRow = typeof unroutedSheetRowsTable.$inferInsert;
