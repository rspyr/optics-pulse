import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { funnelTypesTable } from "./funnel-types";
import { usersTable } from "./users";

export const campaignFunnelMatchCodesTable = pgTable("campaign_funnel_match_codes", {
  id: serial("id").primaryKey(),
  funnelTypeId: integer("funnel_type_id").references(() => funnelTypesTable.id, { onDelete: "cascade" }),
  mappingMode: text("mapping_mode").notNull().default("funnel"),
  code: text("code").notNull(),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("campaign_funnel_match_codes_code_idx").on(sql`lower(${table.code})`),
  index("campaign_funnel_match_codes_funnel_idx").on(table.funnelTypeId),
]);

export type CampaignFunnelMatchCode = typeof campaignFunnelMatchCodesTable.$inferSelect;
