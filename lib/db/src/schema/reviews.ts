import { pgTable, serial, integer, text, real, timestamp, date } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const reviewsTable = pgTable("reviews", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  platform: text("platform").notNull().default("podium"),
  externalId: text("external_id"),
  reviewerName: text("reviewer_name"),
  rating: real("rating"),
  body: text("body"),
  sentiment: text("sentiment"),
  reviewDate: date("review_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const reviewDailyStatsTable = pgTable("review_daily_stats", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  date: date("date").notNull(),
  totalReviews: integer("total_reviews").notNull().default(0),
  averageRating: real("average_rating"),
  positiveCount: integer("positive_count").notNull().default(0),
  negativeCount: integer("negative_count").notNull().default(0),
  neutralCount: integer("neutral_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Review = typeof reviewsTable.$inferSelect;
export type ReviewDailyStat = typeof reviewDailyStatsTable.$inferSelect;
