import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { leadsTable } from "./leads";
import { usersTable } from "./users";

export const callAttemptsTable = pgTable("call_attempts", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  method: text("method").notNull().default("call"),
  outcome: text("outcome").notNull(),
  platform: text("platform").notNull().default("native"),
  attemptedAt: timestamp("attempted_at").notNull().defaultNow(),
  notes: text("notes"),

  actionType: text("action_type").notNull().default("call"),
  callResult: text("call_result"),
  vmResult: text("vm_result"),
  textResult: text("text_result"),
  deadReason: text("dead_reason"),

  spokeResult: text("spoke_result"),
  callbackAt: timestamp("callback_at"),
  appointmentDate: text("appointment_date"),
  appointmentTime: text("appointment_time"),
});

export type CallAttempt = typeof callAttemptsTable.$inferSelect;

export const CALL_RESULTS = [
  "no_answer", "left_voicemail", "vm_full", "vm_not_setup",
  "bad_number", "spoke_with_customer", "hung_up", "blocked",
  "out_of_service_area",
] as const;
export type CallResult = typeof CALL_RESULTS[number];

export const VM_RESULTS = [
  "yes", "no", "bad_number", "vm_full", "vm_not_setup", "spoke_with_customer",
] as const;
export type VmResult = typeof VM_RESULTS[number];

export const TEXT_RESULTS = [
  "yes", "not_able_to", "dead", "no_need", "reached_out",
] as const;
export type TextResult = typeof TEXT_RESULTS[number];

export const ACTION_TYPES = ["call", "text", "voicemail_drop"] as const;
export type ActionType = typeof ACTION_TYPES[number];
