import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const fieldMappingRulesTable = pgTable("field_mapping_rules", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  pageUrlPattern: text("page_url_pattern").notNull(),
  formIdentifier: text("form_identifier").notNull(),
  fieldName: text("field_name").notNull(),
  mapsTo: text("maps_to").notNull(),
  priority: integer("priority").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_tenant_page_form_field").on(table.tenantId, table.pageUrlPattern, table.formIdentifier, table.fieldName),
]);

export type FieldMappingRule = typeof fieldMappingRulesTable.$inferSelect;
