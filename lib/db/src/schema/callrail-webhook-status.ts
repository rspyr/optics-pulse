import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const callrailWebhookStatusTable = pgTable("callrail_webhook_status", {
  tenantId: integer("tenant_id").primaryKey().references(() => tenantsTable.id),
  lastSuccessAt: timestamp("last_success_at"),
  lastFailureAt: timestamp("last_failure_at"),
  lastFailureReason: text("last_failure_reason"),
  lastCallId: text("last_call_id"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CallrailWebhookStatus = typeof callrailWebhookStatusTable.$inferSelect;
