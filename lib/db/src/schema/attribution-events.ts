import { pgTable, serial, integer, text, timestamp, real, pgEnum, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { leadsTable } from "./leads";

export const eventTypeEnum = pgEnum("event_type", ["click", "call", "form_fill"]);
export const matchLevelEnum = pgEnum("match_level", ["diamond", "golden", "silver", "bronze", "unmatched"]);

export const attributionEventsTable = pgTable("attribution_events", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  eventType: eventTypeEnum("event_type").notNull(),
  gclid: text("gclid"),
  wbraid: text("wbraid"),
  fbclid: text("fbclid"),
  msclkid: text("msclkid"),
  ttclid: text("ttclid"),
  liFatId: text("li_fat_id"),
  hashedPhone: text("hashed_phone"),
  hashedEmail: text("hashed_email"),
  billingAddress: text("billing_address"),
  utmSource: text("utm_source"),
  utmCampaign: text("utm_campaign"),
  utmMedium: text("utm_medium"),
  utmTerm: text("utm_term"),
  utmContent: text("utm_content"),
  landingPage: text("landing_page"),
  pageUrl: text("page_url"),
  referrer: text("referrer"),
  userAgent: text("user_agent"),
  externalId: text("external_id"),
  formType: text("form_type"),
  formId: text("form_id"),
  formName: text("form_name"),
  formFields: jsonb("form_fields").$type<Record<string, unknown>>(),
  detectedMappings: jsonb("detected_mappings").$type<Record<string, unknown>>(),
  resolvedLeadSource: text("resolved_lead_source"),
  resolvedFunnel: text("resolved_funnel"),
  submittedAt: timestamp("submitted_at"),
  matchLevel: matchLevelEnum("match_level"),
  matchConfidence: real("match_confidence"),
  createdLeadId: integer("created_lead_id").references(() => leadsTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantExternalIdUnique: uniqueIndex("attribution_events_tenant_external_id_unique").on(table.tenantId, table.externalId),
}));

export const insertAttributionEventSchema = createInsertSchema(attributionEventsTable).omit({ id: true, createdAt: true });
export type InsertAttributionEvent = z.infer<typeof insertAttributionEventSchema>;
export type AttributionEvent = typeof attributionEventsTable.$inferSelect;
