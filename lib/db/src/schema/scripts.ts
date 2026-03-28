import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const scriptsTable = pgTable("scripts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  type: text("type").notNull(),
  name: text("name").notNull(),
  sourceFilter: text("source_filter"),
  stageFilter: text("stage_filter"),
  dispositionFilter: text("disposition_filter"),
  funnelFilter: text("funnel_filter"),
  serviceTypeFilter: text("service_type_filter"),
  content: text("content").notNull(),
  version: integer("version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const scriptVersionsTable = pgTable("script_versions", {
  id: serial("id").primaryKey(),
  scriptId: integer("script_id").notNull().references(() => scriptsTable.id),
  version: integer("version").notNull(),
  content: text("content").notNull(),
  name: text("name").notNull(),
  sourceFilter: text("source_filter"),
  stageFilter: text("stage_filter"),
  dispositionFilter: text("disposition_filter"),
  editedBy: integer("edited_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Script = typeof scriptsTable.$inferSelect;
export type ScriptVersion = typeof scriptVersionsTable.$inferSelect;
