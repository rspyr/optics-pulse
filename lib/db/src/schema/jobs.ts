import { pgTable, serial, integer, text, timestamp, real, pgEnum, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const jobStatusEnum = pgEnum("job_status", ["pending", "in_progress", "completed", "cancelled"]);

export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  stJobId: text("st_job_id"),
  stJobIdHash: text("st_job_id_hash"),
  stCustomerId: text("st_customer_id"),
  stLocationId: text("st_location_id"),
  customerName: text("customer_name"),
  customerPhone: text("customer_phone"),
  customerEmail: text("customer_email"),
  serviceAddress: text("service_address"),
  jobType: text("job_type").notNull(),
  jobTypeName: text("job_type_name"),
  businessUnit: text("business_unit"),
  revenue: real("revenue").notNull().default(0),
  status: jobStatusEnum("status").notNull().default("pending"),
  matchedGclid: text("matched_gclid"),
  matchLevel: text("match_level"),
  completedAt: timestamp("completed_at"),
  stDataExpiresAt: timestamp("st_data_expires_at"),
  hasInvoice: boolean("has_invoice").default(false),
  invoiceTotal: real("invoice_total"),
  invoiceRebateAmount: real("invoice_rebate_amount").default(0),
  invoicePaidAmount: real("invoice_paid_amount"),
  invoiceBalance: real("invoice_balance"),
  stInvoiceId: text("st_invoice_id"),
  invoiceDate: timestamp("invoice_date"),
  invoicePaidOn: timestamp("invoice_paid_on"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
