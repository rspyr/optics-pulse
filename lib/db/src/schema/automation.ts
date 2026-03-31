import { pgTable, serial, integer, text, timestamp, boolean, real, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const automationConditionEnum = pgEnum("automation_condition", [
  "spend_below", "spend_above", "days_active_above", "conversions_below",
  "cpl_above", "roas_below",
]);

export const automationActionEnum = pgEnum("automation_action", [
  "send_alert", "flag_for_review", "auto_pause",
]);

export const automationRulesTable = pgTable("automation_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  conditionType: automationConditionEnum("condition_type").notNull(),
  conditionValue: real("condition_value").notNull(),
  actionType: automationActionEnum("action_type").notNull(),
  lookbackDays: integer("lookback_days").notNull().default(30),
  platform: text("platform"),
  tenantId: integer("tenant_id").references(() => tenantsTable.id),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdBy: integer("created_by").notNull().references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, () => [
  uniqueIndex("uq_automation_rule_identity").using("btree", sql`name`, sql`condition_type`, sql`COALESCE(tenant_id, -1)`),
]);

export const automationAlertsTable = pgTable("automation_alerts", {
  id: serial("id").primaryKey(),
  ruleId: integer("rule_id").notNull().references(() => automationRulesTable.id),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  campaignId: integer("campaign_id"),
  campaignName: text("campaign_name"),
  tenantName: text("tenant_name"),
  conditionType: text("condition_type").notNull(),
  conditionValue: real("condition_value").notNull(),
  actualValue: real("actual_value").notNull(),
  actionType: text("action_type").notNull(),
  actionTaken: text("action_taken"),
  isAcknowledged: boolean("is_acknowledged").notNull().default(false),
  acknowledgedBy: integer("acknowledged_by").references(() => usersTable.id),
  acknowledgedAt: timestamp("acknowledged_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AutomationRule = typeof automationRulesTable.$inferSelect;
export type AutomationAlert = typeof automationAlertsTable.$inferSelect;
