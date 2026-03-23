import { pgTable, serial, integer, real, date, timestamp, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const coordinatorDailyStatsTable = pgTable("coordinator_daily_stats", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  date: date("date").notNull(),
  callsMade: integer("calls_made").notNull().default(0),
  bookingsCount: integer("bookings_count").notNull().default(0),
  bookingRate: real("booking_rate").notNull().default(0),
  commission: real("commission").notNull().default(0),
  avgSpeedToLead: real("avg_speed_to_lead").notNull().default(0),
  soldCount: integer("sold_count").notNull().default(0),
  newLeadsHandled: integer("new_leads_handled").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("coordinator_daily_stats_user_date").on(table.userId, table.date),
]);

export type CoordinatorDailyStat = typeof coordinatorDailyStatsTable.$inferSelect;
