import crypto from "crypto";
import { db, attributionEventsTable, leadsTable, integrationSyncLogsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { scheduleOrEmitNewLead } from "../lead-notify-scheduler";
import { hashPhone, normalizePhone, phoneMatchesSql } from "../../lib/phone-utils";
import { withRetry } from "./rate-limiter";

export function verifyCallRailSignature(
  payload: string,
  signature: string | undefined,
  signingKey: string | undefined,
): boolean {
  if (!signingKey) {
    console.warn("[CallRail] No signing key configured for tenant — rejecting webhook (fail closed)");
    return false;
  }

  if (!signature) return false;

  const hmac = crypto.createHmac("sha1", signingKey).update(payload);
  const expectedBase64 = hmac.digest("base64");
  const expectedHex = crypto.createHmac("sha1", signingKey).update(payload).digest("hex");

  const incoming = signature.replace(/^sha1=/i, "").trim();

  for (const expected of [expectedBase64, expectedHex]) {
    if (incoming.length === expected.length) {
      try {
        if (crypto.timingSafeEqual(Buffer.from(incoming), Buffer.from(expected))) {
          return true;
        }
      } catch {
        // length mismatch after Buffer conversion — ignore and continue
      }
    }
  }
  return false;
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

function parseCallsPage(data: Record<string, unknown>): CallRailCall[] {
  const calls = (data.calls || []) as Record<string, unknown>[];
  return calls.map((c) => ({
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

async function fetchCallRailPage(
  config: CallRailConfig,
  sinceDate: string | undefined,
  page: number,
): Promise<{ calls: CallRailCall[]; totalPages: number }> {
  return withRetry(async () => {
    const url = new URL(`https://api.callrail.com/v3/a/${config.accountId}/calls.json`);
    url.searchParams.set("per_page", "250");
    url.searchParams.set("page", String(page));
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

    const data = await res.json() as Record<string, unknown>;
    const totalPages = Number(data.total_pages || 1);
    return { calls: parseCallsPage(data), totalPages };
  }, { label: `CallRail calls page ${page}`, maxRetries: 3 });
}

export async function fetchCallRailCalls(
  config: CallRailConfig,
  sinceDate?: string,
): Promise<CallRailCall[]> {
  const allCalls: CallRailCall[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const result = await fetchCallRailPage(config, sinceDate, page);
    allCalls.push(...result.calls);
    totalPages = result.totalPages;
    page++;
  }

  return allCalls;
}

export async function syncCallRailCalls(
  tenantId: number,
  config: CallRailConfig,
): Promise<{ synced: number; newCalls: number }> {
  const sinceDate = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

  const syncLog = await db.insert(integrationSyncLogsTable).values({
    tenantId,
    integration: "callrail",
    syncType: "calls",
    status: "running",
    startedAt: new Date(),
  }).returning();
  const logId = syncLog[0]?.id;

  try {
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

      const hashedPhoneValue = call.customerPhoneNumber
        ? hashPhone(call.customerPhoneNumber)
        : null;

      await db.insert(attributionEventsTable).values({
        tenantId,
        eventType: "call",
        gclid: call.gclid || null,
        hashedPhone: hashedPhoneValue,
        utmSource: call.source || "callrail",
        utmCampaign: call.campaign || null,
        utmMedium: call.medium || null,
        landingPage: call.landingPageUrl || null,
        matchLevel: call.gclid ? "diamond" : hashedPhoneValue ? "golden" : "unmatched",
        matchConfidence: call.gclid ? 1.0 : hashedPhoneValue ? 0.9 : 0,
        externalId,
      });

      if (call.customerPhoneNumber || call.customerName) {
        const nameParts = (call.customerName || "").split(" ");
        const firstName = nameParts[0] || "Unknown";
        const lastName = nameParts.slice(1).join(" ") || "";

        const normalizedCustomerPhone = call.customerPhoneNumber
          ? normalizePhone(call.customerPhoneNumber)
          : "";
        const existingLead = normalizedCustomerPhone
          ? await db.select({ id: leadsTable.id }).from(leadsTable)
              .where(and(
                eq(leadsTable.tenantId, tenantId),
                phoneMatchesSql(leadsTable.phone, normalizedCustomerPhone),
              ))
              .limit(1)
          : [];

        if (existingLead.length === 0) {
          const [newLead] = await db.insert(leadsTable).values({
            tenantId,
            firstName,
            lastName,
            phone: normalizedCustomerPhone || null,
            source: call.source || "callrail",
            originalSource: call.source || "callrail",
            leadType: "CallRail",
            interestType: null,
          }).returning();

          if (newLead) {
            const { recordLeadStatusChange } = await import("../lead-status-history");
            await recordLeadStatusChange({
              leadId: newLead.id,
              tenantId,
              fromStatus: null,
              toStatus: newLead.hubStatus,
              changedAt: newLead.createdAt ?? undefined,
              reason: "callrail_sync_create",
            });
            scheduleOrEmitNewLead(newLead.id, (newLead.visibleAfter as Date | null) ?? null);
          }
        }
      }

      newCalls++;
    }

    if (logId) {
      await db.update(integrationSyncLogsTable)
        .set({ status: "completed", recordsProcessed: newCalls, completedAt: new Date() })
        .where(eq(integrationSyncLogsTable.id, logId));
    }

    console.log(`[CallRail] Synced ${calls.length} calls for tenant ${tenantId} (${newCalls} new)`);
    return { synced: calls.length, newCalls };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (logId) {
      await db.update(integrationSyncLogsTable)
        .set({ status: "error", recordsProcessed: 0, completedAt: new Date(), errorMessage: message })
        .where(eq(integrationSyncLogsTable.id, logId));
    }
    console.error(`[CallRail] Sync error for tenant ${tenantId}:`, message);
    throw err;
  }
}
