import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const backgroundJobsTable = pgTable(
  "background_jobs",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    statusRunAtIdx: index("background_jobs_status_run_at_idx").on(t.status, t.runAt),
    typeStatusIdx: index("background_jobs_type_status_idx").on(t.type, t.status),
  }),
);

export type BackgroundJob = typeof backgroundJobsTable.$inferSelect;
export type InsertBackgroundJob = typeof backgroundJobsTable.$inferInsert;
