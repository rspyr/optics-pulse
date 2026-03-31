import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";

export const userLoginSessionsTable = pgTable("user_login_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  tenantId: integer("tenant_id").references(() => tenantsTable.id),
  sessionKey: text("session_key"),
  loginAt: timestamp("login_at").notNull().defaultNow(),
  logoutAt: timestamp("logout_at"),
}, (table) => [
  index("user_login_sessions_user_id_idx").on(table.userId),
  index("user_login_sessions_user_login_idx").on(table.userId, table.loginAt),
  index("user_login_sessions_session_key_idx").on(table.sessionKey),
]);

export type UserLoginSession = typeof userLoginSessionsTable.$inferSelect;
