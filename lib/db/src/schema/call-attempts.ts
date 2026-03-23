import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { leadsTable } from "./leads";
import { usersTable } from "./users";

export const callAttemptsTable = pgTable("call_attempts", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  method: text("method").notNull().default("call"),
  outcome: text("outcome").notNull(),
  platform: text("platform").notNull().default("native"),
  attemptedAt: timestamp("attempted_at").notNull().defaultNow(),
  notes: text("notes"),
});

export type CallAttempt = typeof callAttemptsTable.$inferSelect;
