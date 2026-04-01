import { pgTable, serial, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { leadsTable } from "./leads";

export const podiumMessagesTable = pgTable("podium_messages", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  leadId: integer("lead_id").references(() => leadsTable.id),
  podiumConversationUid: text("podium_conversation_uid").notNull(),
  podiumMessageUid: text("podium_message_uid").notNull(),
  direction: text("direction").notNull(),
  body: text("body"),
  channelType: text("channel_type").notNull().default("sms"),
  senderName: text("sender_name"),
  deliveryStatus: text("delivery_status"),
  podiumCreatedAt: timestamp("podium_created_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("podium_messages_tenant_msg_uid").on(table.tenantId, table.podiumMessageUid),
  index("podium_messages_lead_id").on(table.leadId),
  index("podium_messages_conversation_uid").on(table.podiumConversationUid),
]);

export type PodiumMessage = typeof podiumMessagesTable.$inferSelect;
