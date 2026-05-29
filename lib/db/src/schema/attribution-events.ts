import { pgTable, serial, integer, text, timestamp, real, pgEnum, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { leadsTable } from "./leads";

export const eventTypeEnum = pgEnum("event_type", ["click", "call", "form_fill"]);
export const matchLevelEnum = pgEnum("match_level", ["diamond", "golden", "silver", "bronze", "manual", "unmatched"]);

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
  // One-line "why unmatched?" diagnosis frozen at insert time so audit
  // trails and old screenshots stay reproducible even if the heuristic
  // (computeUnmatchedReason in routes/tracker.ts) is reworded later.
  // Null on matched events and on legacy rows written before this column
  // was added — the read-side fallback in /attribution/events/:id
  // recomputes on demand for those cases.
  unmatchedReason: text("unmatched_reason"),
  // Task #584: when matchLevel='manual', records *how* the operator
  // resolved this event — e.g. `field_mapping_rule:123` or
  // `funnel_override:lead/555`. Null for non-manual rows and for legacy
  // manual rows written before the column existed. Cleared back to null
  // by `revertManualMatchToUnmatched` when the operator undoes the flip.
  manualSource: text("manual_source"),
  createdLeadId: integer("created_lead_id").references(() => leadsTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  tenantExternalIdUnique: uniqueIndex("attribution_events_tenant_external_id_unique").on(table.tenantId, table.externalId),
  // Backs the keyset-paged list endpoint (`/attribution/events`), whose stable
  // ordering is `ORDER BY created_at DESC, id DESC`. The composite index matches
  // that sort order exactly so the database can satisfy both the seek predicate
  // and the ORDER BY from the index alone (no extra sort/scan) as the table grows.
  createdAtIdIdx: index("attribution_events_created_at_id_idx").on(table.createdAt.desc(), table.id.desc()),
  // Tenant-scoped variant of the keyset index. The real `/attribution/events`
  // list query always filters by `tenant_id`, so leading with `tenant_id` lets
  // the planner jump straight to one tenant's slice while still satisfying the
  // `created_at DESC, id DESC` ORDER BY from the index — no scanning over other
  // tenants' rows, no sort.
  tenantCreatedAtIdIdx: index("attribution_events_tenant_created_at_id_idx").on(table.tenantId, table.createdAt.desc(), table.id.desc()),
}));

export const insertAttributionEventSchema = createInsertSchema(attributionEventsTable).omit({ id: true, createdAt: true });
export type InsertAttributionEvent = z.infer<typeof insertAttributionEventSchema>;
export type AttributionEvent = typeof attributionEventsTable.$inferSelect;
