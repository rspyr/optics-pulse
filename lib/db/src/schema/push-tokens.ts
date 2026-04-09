import { pgTable, serial, integer, text, timestamp, unique, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const pushTokensTable = pgTable("push_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  platform: text("platform").notNull().default("expo"),
  subscription: jsonb("subscription"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("push_tokens_user_token_unique").on(table.userId, table.token),
]);

export type PushToken = typeof pushTokensTable.$inferSelect;
export type InsertPushToken = typeof pushTokensTable.$inferInsert;
