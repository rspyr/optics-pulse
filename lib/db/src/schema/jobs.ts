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
  // Human-readable ServiceTitan job number (e.g. "75070"). ServiceTitan has no
  // separate invoice number — an invoice is identified by its job number — so
  // this single value serves as BOTH the portal-findable job # and invoice #.
  // Unlike stJobId/stCustomerId/stLocationId, this is a reference (not PII) and
  // is NEVER purged.
  stJobNumber: text("st_job_number"),
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
  stJobOriginAt: timestamp("st_job_origin_at"),
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
  // Keyset-paged list index for `/jobs` (`ORDER BY created_at DESC, id DESC`).
  // The real `/jobs` list query
  // always filters by `tenant_id`, so leading with `tenant_id` lets the planner
  // jump straight to one tenant's slice while still satisfying the
  // `created_at DESC, id DESC` ORDER BY from the index — no scanning over other
  // tenants' rows, no sort.
  tenantCreatedAtIdIdx: index("jobs_tenant_created_at_id_idx").on(table.tenantId, table.createdAt.desc(), table.id.desc()),
  tenantLeadOriginIdx: index("jobs_tenant_lead_origin_idx").on(table.tenantId, table.leadId, table.stJobOriginAt),
}));

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
