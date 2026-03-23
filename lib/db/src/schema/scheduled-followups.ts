import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { leadsTable } from "./leads";
import { usersTable } from "./users";

export const scheduledFollowupsTable = pgTable("scheduled_followups", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  reason: text("reason").notNull(),
  scheduledFor: timestamp("scheduled_for").notNull(),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ScheduledFollowup = typeof scheduledFollowupsTable.$inferSelect;
