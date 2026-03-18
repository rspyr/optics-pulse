import { pgTable, serial, integer, text, timestamp, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const reconciliationRunsTable = pgTable("reconciliation_runs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").references(() => tenantsTable.id),
  jobsProcessed: integer("jobs_processed").notNull().default(0),
  diamondMatches: integer("diamond_matches").notNull().default(0),
  goldenMatches: integer("golden_matches").notNull().default(0),
  silverMatches: integer("silver_matches").notNull().default(0),
  bronzeMatches: integer("bronze_matches").notNull().default(0),
  unmatchedCount: integer("unmatched_count").notNull().default(0),
  matchRate: real("match_rate").notNull().default(0),
  triggerType: text("trigger_type").notNull().default("manual"),
  status: text("status").notNull().default("completed"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertReconciliationRunSchema = createInsertSchema(reconciliationRunsTable).omit({ id: true, createdAt: true });
export type InsertReconciliationRun = z.infer<typeof insertReconciliationRunSchema>;
export type ReconciliationRun = typeof reconciliationRunsTable.$inferSelect;
