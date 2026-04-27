import { pgTable, serial, integer, text, varchar, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { funnelTypesTable } from "./funnel-types";

export const routingConfigTable = pgTable("routing_config", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  funnelTypeId: integer("funnel_type_id").references(() => funnelTypesTable.id),
  cascadeOrder: jsonb("cascade_order").$type<number[]>().notNull().default([]),
  passIntervalMinutes: integer("pass_interval_minutes").notNull().default(1440),
  allowPassBack: boolean("allow_pass_back").notNull().default(false),
  stickyAfterCascade: boolean("sticky_after_cascade").notNull().default(false),
  stickyCsrId: integer("sticky_csr_id").references(() => usersTable.id),
  backupStickyCsrId: integer("backup_sticky_csr_id").references(() => usersTable.id),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type RoutingConfig = typeof routingConfigTable.$inferSelect;

export const csrScheduleTable = pgTable("csr_schedule", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  isPaused: boolean("is_paused").notNull().default(false),
  pauseSource: varchar("pause_source", { length: 20 }).$type<"manager" | "self" | "auto">().notNull().default("manager"),
  pauseStart: timestamp("pause_start"),
  pauseEnd: timestamp("pause_end"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CsrSchedule = typeof csrScheduleTable.$inferSelect;
