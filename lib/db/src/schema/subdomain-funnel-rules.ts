import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { funnelTypesTable } from "./funnel-types";

export const subdomainFunnelRulesTable = pgTable("subdomain_funnel_rules", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  funnelTypeId: integer("funnel_type_id").notNull().references(() => funnelTypesTable.id, { onDelete: "cascade" }),
  subdomain: text("subdomain").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_tenant_subdomain_funnel").on(table.tenantId, table.subdomain),
]);

export type SubdomainFunnelRule = typeof subdomainFunnelRulesTable.$inferSelect;
