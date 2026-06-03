import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const routeSuggestionDismissalsTable = pgTable("route_suggestion_dismissals", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  routePath: text("route_path").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_tenant_user_route_path_dismissal").on(table.tenantId, table.userId, table.routePath),
]);

export type RouteSuggestionDismissal = typeof routeSuggestionDismissalsTable.$inferSelect;
