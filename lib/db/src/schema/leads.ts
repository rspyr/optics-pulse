import { pgTable, serial, integer, text, boolean, timestamp, pgEnum, jsonb, date, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { funnelTypesTable } from "./funnel-types";

/** @deprecated Legacy enum kept for backward compat only; all new code should use hubStatus */
export const leadStatusEnum = pgEnum("lead_status", ["new", "contacted", "booked", "sold", "lost", "cancelled"]);

export const hubStatusEnum = pgEnum("hub_status_enum", [
  "day_1", "day_2", "day_3", "day_4", "day_5_old",
  "appt_set", "appt_booked", "call_back", "dead",
]);

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  phone: text("phone"),
  email: text("email"),
  source: text("source").notNull(),
  originalSource: text("original_source").notNull().default(""),
  leadType: text("lead_type"),
  interestType: text("interest_type"),
  /** @deprecated Use hubStatus instead. Kept for backward compat. */
  status: leadStatusEnum("status").notNull().default("new"),
  isNewCustomer: boolean("is_new_customer").notNull().default(true),
  matchedGclid: text("matched_gclid"),
  assignedTo: text("assigned_to"),
  disposition: text("disposition"),

  serviceType: text("service_type"),
  funnelId: integer("funnel_id").references(() => funnelTypesTable.id),
  assignedCsrId: integer("assigned_csr_id").references(() => usersTable.id),
  bookedByCsrId: integer("booked_by_csr_id").references(() => usersTable.id),
  hubStatus: hubStatusEnum("hub_status").notNull().default("day_1"),
  dayInSequence: integer("day_in_sequence").notNull().default(1),
  contactPreferences: jsonb("contact_preferences").$type<string[]>().default([]),
  callbackAt: timestamp("callback_at"),
  // Marker used by the callback scheduler to track whether a reminder
  // has already been fired for the current `callbackAt`. INVARIANT: any
  // code path that writes `callbackAt` MUST also set this column to
  // null in the same update so a rescheduled callback re-arms the
  // reminder (the scheduler only fires when
  // `callbackNotifiedAt IS NULL` or `callbackNotifiedAt < callbackAt`).
  callbackNotifiedAt: timestamp("callback_notified_at"),
  revisitDate: date("revisit_date"),
  deadReason: text("dead_reason"),
  preBooked: boolean("pre_booked").notNull().default(false),
  cascadePassCount: integer("cascade_pass_count").notNull().default(0),
  notes: text("notes"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  appointmentDate: text("appointment_date"),
  appointmentTime: text("appointment_time"),
  addOns: text("add_ons"),
  visibleAfter: timestamp("visible_after"),
  newLeadNotifiedAt: timestamp("new_lead_notified_at"),
  podiumContactUid: text("podium_contact_uid"),
  manuallyTransferred: boolean("manually_transferred").notNull().default(false),
  hasSoldEstimate: boolean("has_sold_estimate").notNull().default(false),
  isSpam: boolean("is_spam").notNull().default(false),
  spamReason: text("spam_reason"),
  resubmittedAt: timestamp("resubmitted_at"),
  resubmissionCount: integer("resubmission_count").notNull().default(0),

  // Per-lead funnel override (task #549). When set, the lead's funnelId /
  // leadType are pinned and excluded from alias-driven and rule-driven
  // re-derive paths so a manual correction made from the attribution drawer
  // ("Just this lead") survives later tenant-wide alias edits. Cleared by
  // DELETE /api/leads/:id/funnel-override.
  funnelOverriddenAt: timestamp("funnel_overridden_at"),
  funnelOverriddenByUserId: integer("funnel_overridden_by_user_id").references(() => usersTable.id),

  assignedAt: timestamp("assigned_at").notNull().defaultNow(),
  bookedAt: timestamp("booked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // Keyset-paged list index for `/leads` (`ORDER BY created_at DESC, id DESC`).
  // The real `/leads` list query
  // always filters by `tenant_id` (and optionally bounds `created_at` to a
  // date range), so leading with `tenant_id` lets the planner jump straight to
  // one tenant's slice while still satisfying the `created_at DESC, id DESC`
  // ORDER BY from the index — no scanning over other tenants' rows, no sort.
  tenantCreatedAtIdIdx: index("leads_tenant_created_at_id_idx").on(table.tenantId, table.createdAt.desc(), table.id.desc()),
}));

export const insertLeadSchema = createInsertSchema(leadsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;

export const HUB_STATUSES = ["day_1", "day_2", "day_3", "day_4", "day_5_old", "appt_set", "appt_booked", "call_back", "dead"] as const;
export type HubStatus = typeof HUB_STATUSES[number];

export const CONTACT_PREFERENCES = ["text_only", "spanish_speaking", "do_not_call"] as const;
export type ContactPreference = typeof CONTACT_PREFERENCES[number];

export const SERVICE_TYPES = [
  "Heat Pump", "Service", "A/C", "Zoning", "Furnace",
  "HEPA", "Air Scrubber", "Full System", "Mini Split", "Generator",
] as const;

export const LEAD_SOURCES = [
  "Meta", "Google", "Facebook", "Instagram", "Direct Mail",
  "YouTube", "TikTok", "Email", "ETO Website", "EGIA",
] as const;

export { isUnknownSource } from "@workspace/api-zod";

export const DEAD_REASONS = [
  "out_of_service_area", "do_not_call", "not_interested",
  "too_expensive", "no_response", "other",
] as const;
export type DeadReason = typeof DEAD_REASONS[number];
