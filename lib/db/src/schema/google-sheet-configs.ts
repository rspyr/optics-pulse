import { pgTable, serial, integer, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { funnelTypesTable } from "./funnel-types";

export const googleSheetConfigsTable = pgTable("google_sheet_configs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  name: text("name").notNull(),
  googleSheetId: text("google_sheet_id").notNull(),
  googleSheetTab: text("google_sheet_tab").notNull(),
  columnMapping: jsonb("column_mapping").$type<Record<string, string>>(),
  mappingHeaders: jsonb("mapping_headers").$type<string[]>(),
  syncRowWatermark: integer("sync_row_watermark"),
  syncPaused: boolean("sync_paused").notNull().default(true),
  defaultFunnelTypeId: integer("default_funnel_type_id").references(() => funnelTypesTable.id),
  funnelColumn: text("funnel_column"),
  funnelValueMap: jsonb("funnel_value_map").$type<Record<string, number>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type GoogleSheetConfig = typeof googleSheetConfigsTable.$inferSelect;
export type InsertGoogleSheetConfig = typeof googleSheetConfigsTable.$inferInsert;
