import { pgTable, serial, integer, text, timestamp, boolean, real, pgEnum } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const trainingContentTypeEnum = pgEnum("training_content_type", ["free_tip", "paid_course"]);
export const trainingMetricEnum = pgEnum("training_metric", ["booking_rate", "close_rate", "cpl", "roas", "avg_sale_value"]);
export const trainingThresholdDirectionEnum = pgEnum("training_threshold_direction", ["below", "above"]);

export const trainingItemsTable = pgTable("training_items", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  contentType: trainingContentTypeEnum("content_type").notNull().default("free_tip"),
  metricTrigger: trainingMetricEnum("metric_trigger"),
  thresholdValue: real("threshold_value"),
  thresholdDirection: trainingThresholdDirectionEnum("threshold_direction").default("below"),
  price: real("price"),
  url: text("url"),
  thumbnailUrl: text("thumbnail_url"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const trainingDismissalsTable = pgTable("training_dismissals", {
  id: serial("id").primaryKey(),
  trainingItemId: integer("training_item_id").notNull().references(() => trainingItemsTable.id),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  dismissedAt: timestamp("dismissed_at").notNull().defaultNow(),
});

export const trainingEmailLogsTable = pgTable("training_email_logs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  trainingItemId: integer("training_item_id").notNull().references(() => trainingItemsTable.id),
  metricTrigger: text("metric_trigger").notNull(),
  metricValue: real("metric_value").notNull(),
  thresholdValue: real("threshold_value").notNull(),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
});

export const trainingPurchasesTable = pgTable("training_purchases", {
  id: serial("id").primaryKey(),
  trainingItemId: integer("training_item_id").notNull().references(() => trainingItemsTable.id),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  pricePaid: real("price_paid").notNull(),
  purchasedAt: timestamp("purchased_at").notNull().defaultNow(),
});

export type TrainingItem = typeof trainingItemsTable.$inferSelect;
export type TrainingDismissal = typeof trainingDismissalsTable.$inferSelect;
export type TrainingEmailLog = typeof trainingEmailLogsTable.$inferSelect;
export type TrainingPurchase = typeof trainingPurchasesTable.$inferSelect;
