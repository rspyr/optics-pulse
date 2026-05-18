import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const subdomainSuggestionDismissalsTable = pgTable("subdomain_suggestion_dismissals", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  subdomain: text("subdomain").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_tenant_user_subdomain_dismissal").on(table.tenantId, table.userId, table.subdomain),
]);

export type SubdomainSuggestionDismissal = typeof subdomainSuggestionDismissalsTable.$inferSelect;
