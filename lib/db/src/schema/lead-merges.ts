import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const leadMergesTable = pgTable("lead_merges", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  duplicateLeadId: integer("duplicate_lead_id").notNull(),
  canonicalLeadId: integer("canonical_lead_id").notNull(),
  source: text("source").notNull(),
  runId: text("run_id"),
  mergedAt: timestamp("merged_at").notNull().defaultNow(),
}, (t) => ({
  duplicateUnique: uniqueIndex("lead_merges_duplicate_lead_id_idx").on(t.duplicateLeadId),
  canonicalIdx: index("lead_merges_canonical_lead_id_idx").on(t.canonicalLeadId),
  tenantIdx: index("lead_merges_tenant_id_idx").on(t.tenantId),
}));

export type LeadMerge = typeof leadMergesTable.$inferSelect;
export type InsertLeadMerge = typeof leadMergesTable.$inferInsert;
