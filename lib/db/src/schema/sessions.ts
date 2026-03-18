import { pgTable, text, timestamp, json } from "drizzle-orm/pg-core";

export const sessionsTable = pgTable("session", {
  sid: text("sid").primaryKey(),
  sess: json("sess").notNull(),
  expire: timestamp("expire", { precision: 6 }).notNull(),
});
