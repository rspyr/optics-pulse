import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const oneTimeMigrationsTable = pgTable("_one_time_migrations", {
  id: text("id").primaryKey(),
  description: text("description"),
  executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
});
