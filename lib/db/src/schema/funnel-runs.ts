import { pgTable, serial, integer, text, timestamp, date, pgEnum, index } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { funnelTypesTable } from "./funnel-types";

export const funnelRunStatusEnum = pgEnum("funnel_run_status", ["active", "ended", "archived"]);

export const funnelRunsTable = pgTable("funnel_runs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  funnelTypeId: integer("funnel_type_id").notNull().references(() => funnelTypesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  status: funnelRunStatusEnum("status").notNull().default("active"),
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index("funnel_runs_tenant_id_idx").on(table.tenantId),
  tenantFunnelIdx: index("funnel_runs_tenant_funnel_idx").on(table.tenantId, table.funnelTypeId),
  tenantFunnelStartIdx: index("funnel_runs_tenant_funnel_start_idx").on(table.tenantId, table.funnelTypeId, table.startDate),
  statusIdx: index("funnel_runs_status_idx").on(table.status),
}));

export type FunnelRun = typeof funnelRunsTable.$inferSelect;
