import { pgTable, serial, integer, text, timestamp, real, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { leadsTable } from "./leads";
import { jobsTable } from "./jobs";

export interface RebateBreakdownItem {
  label: string;
  amount: number;
}

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
  // ServiceTitan-reported total (rebates already subtracted out).
  subtotal: real("subtotal").default(0),
  // Sum of rebate line items (ETO, ODEE, ...) added back as true revenue.
  rebateAmount: real("rebate_amount").default(0),
  // Corrected sold revenue = subtotal + rebateAmount.
  totalAmount: real("total_amount").default(0),
  // Audit trail of which line items were counted as rebates.
  rebateBreakdown: jsonb("rebate_breakdown").$type<RebateBreakdownItem[]>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_sold_estimates_tenant_st_id").on(table.tenantId, table.stEstimateId),
]);

export type SoldEstimate = typeof soldEstimatesTable.$inferSelect;
