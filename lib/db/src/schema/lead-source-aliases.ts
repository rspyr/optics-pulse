import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const leadSourceAliasesTable = pgTable("lead_source_aliases", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  canonicalName: text("canonical_name").notNull(),
  alias: text("alias").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_tenant_alias").on(table.tenantId, table.alias),
]);

export type LeadSourceAlias = typeof leadSourceAliasesTable.$inferSelect;
