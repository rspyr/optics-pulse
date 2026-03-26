import crypto from "crypto";
import { db, attributionEventsTable, leadsTable, integrationSyncLogsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { emitNewLead } from "../../socket";

export function verifyCallRailSignature(
  payload: string,
  signature: string | undefined,
  signingKey: string | undefined,
): boolean {
  if (!signingKey) {
    if (process.env.NODE_ENV === "development") {
      console.warn("[CallRail] No signing key configured, skipping verification in dev mode");
      return true;
    }
    return false;
  }

  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", signingKey)
    .update(payload)
    .digest("hex");

  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export interface CallRailConfig {
  apiKey: string;
  accountId: string;
  companyId?: string;
}

interface CallRailCall {
  id: string;
  customerPhoneNumber: string | null;
  customerName: string | null;
  trackingPhoneNumber: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  landingPageUrl: string | null;
  gclid: string | null;
  startTime: string;
  duration: number;
  callType: string;
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value.toLowerCase().trim()).digest("hex");
}

export async function fetchCallRailCalls(
  config: CallRailConfig,
  sinceDate?: string,
): Promise<CallRailCall[]> {
  const url = new URL(`https://api.callrail.com/v3/a/${config.accountId}/calls.json`);
  url.searchParams.set("per_page", "250");
  url.searchParams.set("sort", "start_time");
  url.searchParams.set("order", "desc");
  if (sinceDate) {
    url.searchParams.set("start_date", sinceDate);
  }
  if (config.companyId) {
    url.searchParams.set("company_id", config.companyId);
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Token token=${config.apiKey}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CallRail API error ${res.status}: ${text}`);
  }

  const data = await res.json() as { calls?: Record<string, unknown>[] };
  return (data.calls || []).map((c: Record<string, unknown>) => ({
    id: String(c.id || ""),
    customerPhoneNumber: c.customer_phone_number ? String(c.customer_phone_number) : null,
    customerName: c.customer_name ? String(c.customer_name) : null,
    trackingPhoneNumber: c.tracking_phone_number ? String(c.tracking_phone_number) : null,
    source: c.source ? String(c.source) : null,
    medium: c.medium ? String(c.medium) : null,
    campaign: c.campaign ? String(c.campaign) : null,
    landingPageUrl: c.landing_page_url ? String(c.landing_page_url) : null,
    gclid: c.gclid ? String(c.gclid) : null,
    startTime: String(c.start_time || new Date().toISOString()),
    duration: Number(c.duration || 0),
    callType: String(c.call_type || "unknown"),
  }));
}

export async function syncCallRailCalls(
  tenantId: number,
  config: CallRailConfig,
): Promise<{ synced: number; newCalls: number }> {
  const sinceDate = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

  const calls = await fetchCallRailCalls(config, sinceDate);

  let newCalls = 0;
  for (const call of calls) {
    if (!call.id) continue;

    const externalId = `callrail:${call.id}`;
    const existing = await db.select({ id: attributionEventsTable.id }).from(attributionEventsTable)
      .where(and(
        eq(attributionEventsTable.tenantId, tenantId),
        eq(attributionEventsTable.externalId, externalId),
      ))
      .limit(1);

    if (existing.length > 0) continue;

    const hashedPhone = call.customerPhoneNumber
      ? hashValue(normalizePhone(call.customerPhoneNumber))
      : null;

    await db.insert(attributionEventsTable).values({
      tenantId,
      eventType: "call",
      gclid: call.gclid || null,
      hashedPhone,
      utmSource: call.source || "callrail",
      utmCampaign: call.campaign || null,
      utmMedium: call.medium || null,
      landingPage: call.landingPageUrl || null,
      matchLevel: call.gclid ? "diamond" : hashedPhone ? "golden" : "unmatched",
      matchConfidence: call.gclid ? 1.0 : hashedPhone ? 0.9 : 0,
      externalId,
    });

    if (call.customerPhoneNumber || call.customerName) {
      const nameParts = (call.customerName || "").split(" ");
      const firstName = nameParts[0] || "Unknown";
      const lastName = nameParts.slice(1).join(" ") || "";

      const existingLead = call.customerPhoneNumber
        ? await db.select({ id: leadsTable.id }).from(leadsTable)
            .where(and(
              eq(leadsTable.tenantId, tenantId),
              eq(leadsTable.phone, call.customerPhoneNumber),
            ))
            .limit(1)
        : [];

      if (existingLead.length === 0) {
        const [newLead] = await db.insert(leadsTable).values({
          tenantId,
          firstName,
          lastName,
          phone: call.customerPhoneNumber || null,
          source: call.source || "callrail",
          leadType: "CallRail",
          interestType: null,
        }).returning();

        if (newLead) {
          emitNewLead(tenantId, newLead as unknown as Record<string, unknown>);
        }
      }
    }

    newCalls++;
  }

  console.log(`[CallRail] Synced ${calls.length} calls for tenant ${tenantId} (${newCalls} new)`);
  return { synced: calls.length, newCalls };
}
