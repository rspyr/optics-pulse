import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const trackerHeartbeatsTable = pgTable("tracker_heartbeats", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  domain: text("domain"),
  userAgent: text("user_agent"),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
});

export type TrackerHeartbeat = typeof trackerHeartbeatsTable.$inferSelect;
