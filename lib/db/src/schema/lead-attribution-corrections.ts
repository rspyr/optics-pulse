import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { leadsTable } from "./leads";
import { usersTable } from "./users";
import { leadSourceAliasesTable } from "./lead-source-aliases";
import { funnelAliasesTable } from "./funnel-aliases";

export const leadAttributionCorrectionsTable = pgTable("lead_attribution_corrections", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedByUserId: integer("changed_by_user_id").references(() => usersTable.id),
  sourceAliasId: integer("source_alias_id").references(() => leadSourceAliasesTable.id, { onDelete: "set null" }),
  funnelAliasId: integer("funnel_alias_id").references(() => funnelAliasesTable.id, { onDelete: "set null" }),
  changedAt: timestamp("changed_at").notNull().defaultNow(),
}, (table) => [
  index("idx_lead_attr_corrections_lead").on(table.leadId, table.changedAt),
]);

export type LeadAttributionCorrection = typeof leadAttributionCorrectionsTable.$inferSelect;
