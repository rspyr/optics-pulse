import { pgTable, serial, integer, text, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const leadStatusEnum = pgEnum("lead_status", ["new", "contacted", "booked", "sold", "lost", "cancelled"]);

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
  status: leadStatusEnum("status").notNull().default("new"),
  isNewCustomer: boolean("is_new_customer").notNull().default(true),
  matchedGclid: text("matched_gclid"),
  assignedTo: text("assigned_to"),
  disposition: text("disposition"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertLeadSchema = createInsertSchema(leadsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
