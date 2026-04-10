import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { funnelTypesTable } from "./funnel-types";

export const funnelAliasesTable = pgTable("funnel_aliases", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  funnelTypeId: integer("funnel_type_id").notNull().references(() => funnelTypesTable.id, { onDelete: "cascade" }),
  alias: text("alias").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_tenant_funnel_alias").on(table.tenantId, table.alias),
]);

export type FunnelAlias = typeof funnelAliasesTable.$inferSelect;
