import { pgTable, serial, integer, text, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const integrationSyncLogsTable = pgTable("integration_sync_logs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  integration: text("integration").notNull(),
  syncType: text("sync_type").notNull(),
  status: text("status").notNull().default("running"),
  recordsProcessed: integer("records_processed").notNull().default(0),
  errorMessage: text("error_message"),
  // Structured progress + error metadata for backfill-style runs (Task #395).
  // Replaces the historical practice of stuffing `chunk N/M: …` and
  // `partial: …` strings into `errorMessage` for the Settings UI to
  // reverse-parse with regex. Writers populate these directly; the
  // /sync-status route reads them and falls back to the regex parser only
  // for old rows that pre-date this schema change.
  progressCurrentChunk: integer("progress_current_chunk"),
  progressTotalChunks: integer("progress_total_chunks"),
  progressWindowStart: text("progress_window_start"),
  progressWindowEnd: text("progress_window_end"),
  errorCode: text("error_code"),
  partial: boolean("partial").notNull().default(false),
  metadata: jsonb("metadata"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type IntegrationSyncLog = typeof integrationSyncLogsTable.$inferSelect;
