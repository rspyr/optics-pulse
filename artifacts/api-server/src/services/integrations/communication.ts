import { db, tenantsTable, callAttemptsTable, leadsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptConfig } from "../../lib/encryption";

export interface CommunicationConfig {
  callPlatform: "native" | "callrail" | "podium";
  textPlatform: "native" | "podium";
  callRailAccountId?: string;
  callRailApiKey?: string;
  callRailCompanyId?: string;
  callRailTrackingNumber?: string;
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
    callRailAccountId: (apiConfig.callRailAccountId as string) || undefined,
    callRailApiKey: (apiConfig.callRailApiKey as string) || undefined,
    callRailCompanyId: (apiConfig.callRailCompanyId as string) || undefined,
    callRailTrackingNumber: (apiConfig.callRailTrackingNumber as string) || undefined,
    podiumApiToken: (apiConfig.podiumApiToken as string) || undefined,
    podiumLocationId: (apiConfig.podiumLocationId as string) || undefined,
    podiumPhoneNumber: (apiConfig.podiumPhoneNumber as string) || undefined,
  };
}

async function getCoordinatorPhone(userId: number): Promise<string | null> {
  const [user] = await db.select({ phone: usersTable.phone }).from(usersTable).where(eq(usersTable.id, userId));
  return user?.phone || null;
}

export async function initiateCall(
  tenantId: number,
  leadId: number,
  userId: number,
): Promise<CallResult> {
  const config = await getTenantCommConfig(tenantId);
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) throw new Error("Lead not found");
  if (!lead.phone) throw new Error("Lead has no phone number");

  const customerPhone = lead.phone.replace(/[^0-9+]/g, "");
  let result: CallResult;

  switch (config.callPlatform) {
    case "callrail": {
      const coordinatorPhone = await getCoordinatorPhone(userId);
      result = await initiateCallRailCall(config, customerPhone, coordinatorPhone);
      break;
    }
    case "podium":
      result = await initiatePodiumCall(config, customerPhone);
      break;
    default:
      result = {
        success: true,
        platform: "native",
        message: `Use your phone to call ${customerPhone}`,
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

  const customerPhone = lead.phone.replace(/[^0-9+]/g, "");
  let result: TextResult;

  switch (config.textPlatform) {
    case "podium":
      result = await sendPodiumText(config, customerPhone, messageBody);
      break;
    default:
      result = {
        success: true,
        platform: "native",
        message: `Use your phone to text ${customerPhone}`,
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
  customerPhone: string,
  coordinatorPhone: string | null,
): Promise<CallResult> {
  if (!config.callRailApiKey || !config.callRailAccountId) {
    return { success: false, platform: "callrail", message: "CallRail not configured — missing API key or account ID" };
  }

  if (!coordinatorPhone) {
    return { success: false, platform: "callrail", message: "Your profile has no phone number set — add your phone in settings to use CallRail click-to-call" };
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
          caller_id: coordinatorPhone,
          customer_phone_number: customerPhone,
          ...(config.callRailTrackingNumber ? { tracking_phone_number: config.callRailTrackingNumber } : {}),
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
      message: "Call initiated through CallRail — your phone will ring shortly",
      externalId: String(data.id || ""),
    };
  } catch (err) {
    console.error("[CallRail] Call initiation error:", err);
    return { success: false, platform: "callrail", message: "Failed to connect to CallRail" };
  }
}

async function initiatePodiumCall(
  config: CommunicationConfig,
  customerPhone: string,
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
          customerPhoneNumber: customerPhone,
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
  customerPhone: string,
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
          customerPhoneNumber: customerPhone,
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
    callStatusMessage = callReady ? "CallRail connected" : "CallRail credentials missing — add API key and account ID in API Integrations above";
  } else if (config.callPlatform === "podium") {
    callReady = !!(config.podiumApiToken && config.podiumLocationId);
    callStatusMessage = callReady ? "Podium connected" : "Podium credentials missing — add API token and location ID in API Integrations above";
  }

  if (config.textPlatform === "podium") {
    textReady = !!(config.podiumApiToken && config.podiumLocationId);
    textStatusMessage = textReady ? "Podium connected" : "Podium credentials missing — add API token and location ID in API Integrations above";
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
