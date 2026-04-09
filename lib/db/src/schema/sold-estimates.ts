import { pgTable, serial, integer, text, timestamp, real, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { leadsTable } from "./leads";
import { jobsTable } from "./jobs";

export const soldEstimatesTable = pgTable("sold_estimates", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  leadId: integer("lead_id").references(() => leadsTable.id),
  jobId: integer("job_id").references(() => jobsTable.id),
  stEstimateId: text("st_estimate_id").notNull(),
  stJobId: text("st_job_id"),
  soldByName: text("sold_by_name"),
  soldByStEmployeeId: integer("sold_by_st_employee_id"),
  soldOn: timestamp("sold_on"),
  subtotal: real("subtotal").default(0),
  rebateAmount: real("rebate_amount").default(0),
  totalAmount: real("total_amount").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_sold_estimates_tenant_st_id").on(table.tenantId, table.stEstimateId),
]);

export type SoldEstimate = typeof soldEstimatesTable.$inferSelect;
