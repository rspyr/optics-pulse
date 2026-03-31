import { db, callAttemptsTable, leadsTable, usersTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface CommunicationConfig {
  callPlatform: "native" | "none";
  textPlatform: "native" | "none";
}

export interface CallResult {
  success: boolean;
  platform: string;
  message: string;
  externalId?: string;
}

export interface TextResult {
  success: boolean;
  platform: string;
  message: string;
  externalId?: string;
}

export async function getTenantCommConfig(tenantId: number): Promise<CommunicationConfig> {
  const [tenant] = await db
    .select({ communicationConfig: tenantsTable.communicationConfig })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId));
  const cc = (tenant?.communicationConfig || {}) as Record<string, unknown>;
  const callPlatform = cc.callPlatform === "none" ? "none" : "native";
  const textPlatform = cc.textPlatform === "none" ? "none" : "native";
  return { callPlatform, textPlatform };
}

export async function initiateCall(
  tenantId: number,
  leadId: number,
  userId: number,
): Promise<CallResult> {
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) throw new Error("Lead not found");
  if (!lead.phone) throw new Error("Lead has no phone number");

  const customerPhone = lead.phone.replace(/[^0-9+]/g, "");
  const result: CallResult = {
    success: true,
    platform: "native",
    message: `Use your phone to call ${customerPhone}`,
  };

  await db.insert(callAttemptsTable).values({
    leadId,
    userId,
    method: "call",
    outcome: "initiated",
    platform: "native",
    actionType: "call",
  });

  return result;
}

export async function initiateText(
  tenantId: number,
  leadId: number,
  userId: number,
  messageBody: string,
): Promise<TextResult> {
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) throw new Error("Lead not found");
  if (!lead.phone) throw new Error("Lead has no phone number");

  const customerPhone = lead.phone.replace(/[^0-9+]/g, "");
  const result: TextResult = {
    success: true,
    platform: "native",
    message: `Use your phone to text ${customerPhone}`,
  };

  await db.insert(callAttemptsTable).values({
    leadId,
    userId,
    method: "text",
    outcome: "sent",
    platform: "native",
    actionType: "text",
  });

  return result;
}

export function getCommConfigStatus(config: CommunicationConfig): {
  callPlatform: string;
  textPlatform: string;
  callReady: boolean;
  textReady: boolean;
  callStatusMessage: string;
  textStatusMessage: string;
} {
  const callNone = config.callPlatform === "none";
  const textNone = config.textPlatform === "none";
  return {
    callPlatform: config.callPlatform,
    textPlatform: config.textPlatform,
    callReady: !callNone,
    textReady: !textNone,
    callStatusMessage: callNone ? "No communication platform configured" : "Using native phone dialer",
    textStatusMessage: textNone ? "No communication platform configured" : "Using native SMS app",
  };
}
