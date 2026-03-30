import { pgTable, serial, integer, text, boolean, timestamp, pgEnum, jsonb, date } from "drizzle-orm/pg-core";
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
  hubStatus: hubStatusEnum("hub_status").notNull().default("day_1"),
  dayInSequence: integer("day_in_sequence").notNull().default(1),
  contactPreferences: jsonb("contact_preferences").$type<string[]>().default([]),
  callbackAt: timestamp("callback_at"),
  revisitDate: date("revisit_date"),
  deadReason: text("dead_reason"),
  preBooked: boolean("pre_booked").notNull().default(false),
  cascadePassCount: integer("cascade_pass_count").notNull().default(0),
  notes: text("notes"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

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

export const DEAD_REASONS = [
  "out_of_service_area", "do_not_call", "not_interested",
  "too_expensive", "no_response", "other",
] as const;
export type DeadReason = typeof DEAD_REASONS[number];
