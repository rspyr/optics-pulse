import { pgTable, serial, integer, text, timestamp, real, pgEnum, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { leadsTable } from "./leads";

export const jobStatusEnum = pgEnum("job_status", ["pending", "in_progress", "completed", "cancelled"]);

export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  leadId: integer("lead_id").references(() => leadsTable.id),
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
  ociUploadedAt: timestamp("oci_uploaded_at"),
  enhancedConversionUploadedAt: timestamp("enhanced_conversion_uploaded_at"),
  capiUploadedAt: timestamp("capi_uploaded_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // Backs the keyset-paged list endpoint (`/jobs`), whose stable ordering is
  // `ORDER BY created_at DESC, id DESC`. The composite index matches that sort
  // order exactly so the database can satisfy both the seek predicate and the
  // ORDER BY from the index alone (no extra sort/scan) as the table grows.
  createdAtIdIdx: index("jobs_created_at_id_idx").on(table.createdAt.desc(), table.id.desc()),
}));

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
