import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const funnelTypesTable = pgTable("funnel_types", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FunnelType = typeof funnelTypesTable.$inferSelect;
