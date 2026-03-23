import { db, tenantsTable, callAttemptsTable, leadsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptConfig } from "../../lib/encryption";

export interface CommunicationConfig {
  callPlatform: "native" | "callrail" | "podium";
  textPlatform: "native" | "podium";
  callRailAccountId?: string;
  callRailApiKey?: string;
  callRailCompanyId?: string;
  podiumApiToken?: string;
  podiumLocationId?: string;
  podiumPhoneNumber?: string;
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
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) throw new Error("Tenant not found");

  const commConfig = (tenant.communicationConfig || {}) as Record<string, unknown>;

  let apiConfig: Record<string, unknown> = {};
  if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
    try {
      apiConfig = decryptConfig(tenant.apiConfig);
    } catch {}
  }

  return {
    callPlatform: (commConfig.callPlatform as CommunicationConfig["callPlatform"]) || "native",
    textPlatform: (commConfig.textPlatform as CommunicationConfig["textPlatform"]) || "native",
    callRailAccountId: (apiConfig.callRailAccountId as string) || (commConfig.callRailAccountId as string) || undefined,
    callRailApiKey: (apiConfig.callRailApiKey as string) || (commConfig.callRailApiKey as string) || undefined,
    callRailCompanyId: (apiConfig.callRailCompanyId as string) || (commConfig.callRailCompanyId as string) || undefined,
    podiumApiToken: (apiConfig.podiumApiToken as string) || (commConfig.podiumApiToken as string) || undefined,
    podiumLocationId: (apiConfig.podiumLocationId as string) || (commConfig.podiumLocationId as string) || undefined,
    podiumPhoneNumber: (commConfig.podiumPhoneNumber as string) || undefined,
  };
}

export async function initiateCall(
  tenantId: number,
  leadId: number,
  userId: number,
  callerPhone?: string,
): Promise<CallResult> {
  const config = await getTenantCommConfig(tenantId);
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) throw new Error("Lead not found");
  if (!lead.phone) throw new Error("Lead has no phone number");

  const cleanPhone = lead.phone.replace(/[^0-9+]/g, "");
  let result: CallResult;

  switch (config.callPlatform) {
    case "callrail":
      result = await initiateCallRailCall(config, cleanPhone, callerPhone);
      break;
    case "podium":
      result = await initiatePodiumCall(config, cleanPhone);
      break;
    default:
      result = {
        success: true,
        platform: "native",
        message: `Use your phone to call ${cleanPhone}`,
      };
  }

  await db.insert(callAttemptsTable).values({
    leadId,
    userId,
    method: "call",
    outcome: result.success ? "initiated" : "failed",
    platform: config.callPlatform,
    notes: result.message,
  });

  return result;
}

export async function initiateText(
  tenantId: number,
  leadId: number,
  userId: number,
  messageBody: string,
): Promise<TextResult> {
  const config = await getTenantCommConfig(tenantId);
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) throw new Error("Lead not found");
  if (!lead.phone) throw new Error("Lead has no phone number");

  const cleanPhone = lead.phone.replace(/[^0-9+]/g, "");
  let result: TextResult;

  switch (config.textPlatform) {
    case "podium":
      result = await sendPodiumText(config, cleanPhone, messageBody);
      break;
    default:
      result = {
        success: true,
        platform: "native",
        message: `Use your phone to text ${cleanPhone}`,
      };
  }

  await db.insert(callAttemptsTable).values({
    leadId,
    userId,
    method: "text",
    outcome: result.success ? "sent" : "failed",
    platform: config.textPlatform,
    notes: result.message,
  });

  return result;
}

async function initiateCallRailCall(
  config: CommunicationConfig,
  targetPhone: string,
  callerPhone?: string,
): Promise<CallResult> {
  if (!config.callRailApiKey || !config.callRailAccountId) {
    return { success: false, platform: "callrail", message: "CallRail not configured — missing API key or account ID" };
  }

  try {
    const res = await fetch(
      `https://api.callrail.com/v3/a/${config.callRailAccountId}/calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Token token=${config.callRailApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          caller_id: callerPhone || undefined,
          business_phone_number: targetPhone,
          customer_phone_number: targetPhone,
          ...(config.callRailCompanyId ? { company_id: config.callRailCompanyId } : {}),
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`[CallRail] Call initiation failed (${res.status}):`, text);
      return { success: false, platform: "callrail", message: `CallRail error: ${res.status}` };
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      success: true,
      platform: "callrail",
      message: "Call initiated through CallRail",
      externalId: String(data.id || ""),
    };
  } catch (err) {
    console.error("[CallRail] Call initiation error:", err);
    return { success: false, platform: "callrail", message: "Failed to connect to CallRail" };
  }
}

async function initiatePodiumCall(
  config: CommunicationConfig,
  targetPhone: string,
): Promise<CallResult> {
  if (!config.podiumApiToken || !config.podiumLocationId) {
    return { success: false, platform: "podium", message: "Podium not configured — missing API token or location ID" };
  }

  try {
    const res = await fetch(
      `https://api.podium.com/v4/locations/${config.podiumLocationId}/interactions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.podiumApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "phone",
          customerPhoneNumber: targetPhone,
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Podium] Call initiation failed (${res.status}):`, text);
      return { success: false, platform: "podium", message: `Podium error: ${res.status}` };
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      success: true,
      platform: "podium",
      message: "Call initiated through Podium",
      externalId: String(data.uid || data.id || ""),
    };
  } catch (err) {
    console.error("[Podium] Call initiation error:", err);
    return { success: false, platform: "podium", message: "Failed to connect to Podium" };
  }
}

async function sendPodiumText(
  config: CommunicationConfig,
  targetPhone: string,
  messageBody: string,
): Promise<TextResult> {
  if (!config.podiumApiToken || !config.podiumLocationId) {
    return { success: false, platform: "podium", message: "Podium not configured — missing API token or location ID" };
  }

  try {
    const res = await fetch(
      `https://api.podium.com/v4/locations/${config.podiumLocationId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.podiumApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customerPhoneNumber: targetPhone,
          body: messageBody,
          ...(config.podiumPhoneNumber ? { sendingPhoneNumber: config.podiumPhoneNumber } : {}),
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Podium] Text send failed (${res.status}):`, text);
      return { success: false, platform: "podium", message: `Podium error: ${res.status}` };
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      success: true,
      platform: "podium",
      message: "Text sent through Podium",
      externalId: String(data.uid || data.id || ""),
    };
  } catch (err) {
    console.error("[Podium] Text send error:", err);
    return { success: false, platform: "podium", message: "Failed to connect to Podium" };
  }
}

export function getCommConfigStatus(config: CommunicationConfig): {
  callPlatform: string;
  textPlatform: string;
  callReady: boolean;
  textReady: boolean;
  callStatusMessage: string;
  textStatusMessage: string;
} {
  let callReady = true;
  let callStatusMessage = "Using native phone dialer";
  let textReady = true;
  let textStatusMessage = "Using native SMS app";

  if (config.callPlatform === "callrail") {
    callReady = !!(config.callRailApiKey && config.callRailAccountId);
    callStatusMessage = callReady ? "CallRail connected" : "CallRail credentials missing";
  } else if (config.callPlatform === "podium") {
    callReady = !!(config.podiumApiToken && config.podiumLocationId);
    callStatusMessage = callReady ? "Podium connected" : "Podium credentials missing";
  }

  if (config.textPlatform === "podium") {
    textReady = !!(config.podiumApiToken && config.podiumLocationId);
    textStatusMessage = textReady ? "Podium connected" : "Podium credentials missing";
  }

  return {
    callPlatform: config.callPlatform,
    textPlatform: config.textPlatform,
    callReady,
    textReady,
    callStatusMessage,
    textStatusMessage,
  };
}
