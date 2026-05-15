import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { leadsTable } from "./leads";
import { usersTable } from "./users";

/**
 * Append-only record of every lead status transition. One row is written each
 * time `leads.hub_status` (or the legacy `leads.status` cache) changes, so the
 * full history can be replayed for audits, time-to-book / rebook metrics, and
 * exact historical re-aggregation that the mutable `leads.booked_at` snapshot
 * cannot support (a re-book overwrites the prior moment).
 *
 * Maintained from application code at every status-mutation site
 * (leads-hub.ts spoke/appt flows, socket.ts demo, ingestion, resubmission,
 * sheet-sync). Backfilled by the matching one-time migration so historical
 * `booked_at` values are preserved as audit rows.
 */
export const leadStatusHistoryTable = pgTable("lead_status_history", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  changedAt: timestamp("changed_at").notNull().defaultNow(),
  changedByUserId: integer("changed_by_user_id").references(() => usersTable.id),
  reason: text("reason"),
}, (t) => [
  index("lead_status_history_lead_idx").on(t.leadId, t.changedAt),
  index("lead_status_history_to_status_idx").on(t.toStatus, t.changedAt),
  index("lead_status_history_tenant_idx").on(t.tenantId, t.changedAt),
]);

export type LeadStatusHistory = typeof leadStatusHistoryTable.$inferSelect;
export type InsertLeadStatusHistory = typeof leadStatusHistoryTable.$inferInsert;
