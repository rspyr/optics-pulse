import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenants";
import { leadsTable } from "./leads";
import { usersTable } from "./users";

/**
 * Permanent record of every assignment window for a lead. A new row is written
 * each time `leads.assigned_csr_id` or `leads.assigned_at` changes; the prior
 * row's `ended_at` is set to the new `assigned_at`.
 *
 * Maintained automatically by a postgres trigger on `leads` (see the
 * one-time-migrations service), so no application code can bypass it.
 *
 * Used by coordinator-stats to compute first-response events per
 * (lead, assignment-window) — giving exact, reproducible historical
 * speed-to-lead numbers even after subsequent reassignments.
 */
export const leadAssignmentsTable = pgTable("lead_assignments", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  assignedCsrId: integer("assigned_csr_id").references(() => usersTable.id),
  assignedAt: timestamp("assigned_at").notNull(),
  endedAt: timestamp("ended_at"),
  reason: text("reason").notNull().default("change"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("lead_assignments_lead_idx").on(t.leadId, t.assignedAt),
  index("lead_assignments_csr_idx").on(t.assignedCsrId, t.assignedAt),
  uniqueIndex("lead_assignments_one_active_per_lead").on(t.leadId).where(sql`ended_at IS NULL`),
]);

export type LeadAssignment = typeof leadAssignmentsTable.$inferSelect;
