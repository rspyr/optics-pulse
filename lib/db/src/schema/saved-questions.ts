import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const savedQuestionsTable = pgTable("saved_questions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  question: text("question").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type SavedQuestion = typeof savedQuestionsTable.$inferSelect;
