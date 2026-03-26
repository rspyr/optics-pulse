import { pgTable, serial, integer, text, timestamp, real, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const eventTypeEnum = pgEnum("event_type", ["click", "call", "form_fill"]);
export const matchLevelEnum = pgEnum("match_level", ["diamond", "golden", "silver", "bronze", "unmatched"]);

export const attributionEventsTable = pgTable("attribution_events", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  eventType: eventTypeEnum("event_type").notNull(),
  gclid: text("gclid"),
  wbraid: text("wbraid"),
  fbclid: text("fbclid"),
  hashedPhone: text("hashed_phone"),
  hashedEmail: text("hashed_email"),
  billingAddress: text("billing_address"),
  utmSource: text("utm_source"),
  utmCampaign: text("utm_campaign"),
  utmMedium: text("utm_medium"),
  landingPage: text("landing_page"),
  userAgent: text("user_agent"),
  externalId: text("external_id"),
  matchLevel: matchLevelEnum("match_level"),
  matchConfidence: real("match_confidence"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAttributionEventSchema = createInsertSchema(attributionEventsTable).omit({ id: true, createdAt: true });
export type InsertAttributionEvent = z.infer<typeof insertAttributionEventSchema>;
export type AttributionEvent = typeof attributionEventsTable.$inferSelect;
