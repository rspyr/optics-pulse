import crypto from "crypto";
import { db, attributionEventsTable, leadsTable, integrationSyncLogsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { scheduleOrEmitNewLead } from "../lead-notify-scheduler";
import { hashPhone, normalizePhone, phoneMatchesSql } from "../../lib/phone-utils";
import { withRetry } from "./rate-limiter";

const CALLRAIL_SOURCE_FIELDS = [
  "call_type",
  "campaign",
  "company_id",
  "company_name",
  "fbclid",
  "formatted_tracking_source",
  "gclid",
  "keywords",
  "landing_page_url",
  "last_requested_url",
  "medium",
  "milestones",
  "msclkid",
  "person_id",
  "referrer_domain",
  "referring_url",
  "source",
  "source_name",
  "tags",
  "tracker_id",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
];

export const DEFAULT_CALLRAIL_SYNC_DAYS = 30;
export const DEFAULT_CALLRAIL_BACKFILL_DAYS = 90;
export const MAX_CALLRAIL_BACKFILL_DAYS = 730;

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
  sourceName: string | null;
  formattedTrackingSource: string | null;
  medium: string | null;
  campaign: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  landingPageUrl: string | null;
  lastRequestedUrl: string | null;
  referrer: string | null;
  gclid: string | null;
  fbclid: string | null;
  msclkid: string | null;
  personId: string | null;
  trackerId: string | null;
  startTime: string;
  duration: number;
  callType: string;
  milestones: Record<string, unknown> | null;
}

export type CallRailCreateLeadMode = "active" | "attribution_only" | "none";

interface CallRailSyncOptions {
  days?: number;
  syncType?: "calls" | "backfill";
  createLeadMode?: CallRailCreateLeadMode;
  triggeredBySyncLogId?: number | null;
}

export interface CallRailPulseLeadCleanupResult {
  tenantId: number;
  dryRun: boolean;
  candidates: number;
  deletedLeads: number;
  attributionEventsUnlinked: number;
  jobsUnlinked: number;
  soldEstimatesUnlinked: number;
  podiumMessagesUnlinked: number;
  scheduledFollowupsDeleted: number;
  callAttemptsDeleted: number;
  leadStatusHistoryDeleted: number;
  leadAssignmentsDeleted: number;
  leadAttributionCorrectionsDeleted: number;
  leadMergeRowsDeleted: number;
  unroutedRowsUnlinked: number;
  samples: Array<{
    id: number;
    name: string;
    source: string | null;
    leadType: string | null;
    serviceType: string | null;
    hubStatus: string | null;
    createdAt: string | null;
  }>;
  byHubStatus: Record<string, number>;
  byStatus: Record<string, number>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function pickString(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(data[key]);
    if (value) return value;
  }
  return null;
}

function urlParam(url: string | null, name: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return stringValue(parsed.searchParams.get(name));
  } catch {
    return null;
  }
}

function milestoneValue(milestones: Record<string, unknown> | null, key: string): string | null {
  if (!milestones) return null;
  const preferred = ["lead_created", "last_touch", "first_touch", "qualified"];
  for (const name of preferred) {
    const milestone = milestones[name];
    if (!milestone || typeof milestone !== "object") continue;
    const record = milestone as Record<string, unknown>;
    const direct = stringValue(record[key]);
    if (direct) return direct;
    if (key.startsWith("utm_") && record.url_utm_params && typeof record.url_utm_params === "object") {
      const fromUtm = stringValue((record.url_utm_params as Record<string, unknown>)[key.replace(/^utm_/, "")]);
      if (fromUtm) return fromUtm;
    }
    if (record.landing_page_url_params && typeof record.landing_page_url_params === "object") {
      const fromLanding = stringValue((record.landing_page_url_params as Record<string, unknown>)[key]);
      if (fromLanding) return fromLanding;
    }
  }
  return null;
}

function parseCallTime(startTime: string): Date {
  const parsed = new Date(startTime);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function hasAnyClickId(call: CallRailCall): boolean {
  return !!(call.gclid || call.fbclid || call.msclkid);
}

function resolvedSource(call: CallRailCall): string {
  return call.source
    || call.formattedTrackingSource
    || call.utmSource
    || (call.fbclid ? "Facebook Ads" : null)
    || (call.gclid ? "Google Ads" : null)
    || (call.msclkid ? "Microsoft Ads" : null)
    || "CallRail";
}

function resolvedCampaign(call: CallRailCall): string | null {
  return call.utmCampaign || call.campaign || call.sourceName;
}

function resolvedMedium(call: CallRailCall): string | null {
  return call.utmMedium || call.medium;
}

function resolvedLeadType(call: CallRailCall): string {
  return call.sourceName || call.campaign || call.formattedTrackingSource || "CallRail";
}

function parseCallsPage(data: Record<string, unknown>): CallRailCall[] {
  const calls = (data.calls || []) as Record<string, unknown>[];
  return calls.map((c) => {
    const milestones = c.milestones && typeof c.milestones === "object"
      ? c.milestones as Record<string, unknown>
      : null;
    const landingPageUrl = pickString(c, ["landing_page_url", "landing", "last_requested_url"]);
    const source = pickString(c, ["source", "formatted_tracking_source"])
      || milestoneValue(milestones, "source");
    const medium = pickString(c, ["medium", "utm_medium"])
      || milestoneValue(milestones, "medium")
      || urlParam(landingPageUrl, "utm_medium");
    const campaign = pickString(c, ["campaign", "utm_campaign"])
      || milestoneValue(milestones, "campaign")
      || urlParam(landingPageUrl, "utm_campaign")
      || urlParam(landingPageUrl, "campaign");
    const gclid = pickString(c, ["gclid"])
      || milestoneValue(milestones, "gclid")
      || urlParam(landingPageUrl, "gclid");
    const fbclid = pickString(c, ["fbclid"])
      || milestoneValue(milestones, "fbclid")
      || urlParam(landingPageUrl, "fbclid");
    const msclkid = pickString(c, ["msclkid"])
      || milestoneValue(milestones, "msclkid")
      || urlParam(landingPageUrl, "msclkid");

    return {
      id: String(c.id || ""),
      customerPhoneNumber: pickString(c, ["customer_phone_number"]),
      customerName: pickString(c, ["customer_name", "formatted_customer_name"]),
      trackingPhoneNumber: pickString(c, ["tracking_phone_number"]),
      source,
      sourceName: pickString(c, ["source_name"]),
      formattedTrackingSource: pickString(c, ["formatted_tracking_source"]),
      medium,
      campaign,
      utmSource: pickString(c, ["utm_source"]) || milestoneValue(milestones, "utm_source") || urlParam(landingPageUrl, "utm_source"),
      utmMedium: pickString(c, ["utm_medium"]) || milestoneValue(milestones, "utm_medium") || urlParam(landingPageUrl, "utm_medium"),
      utmCampaign: pickString(c, ["utm_campaign"]) || milestoneValue(milestones, "utm_campaign") || urlParam(landingPageUrl, "utm_campaign"),
      utmTerm: pickString(c, ["utm_term"]) || milestoneValue(milestones, "utm_term") || urlParam(landingPageUrl, "utm_term"),
      utmContent: pickString(c, ["utm_content"]) || milestoneValue(milestones, "utm_content") || urlParam(landingPageUrl, "utm_content"),
      landingPageUrl,
      lastRequestedUrl: pickString(c, ["last_requested_url"]),
      referrer: pickString(c, ["referring_url", "referrer_domain"]) || milestoneValue(milestones, "referrer"),
      gclid,
      fbclid,
      msclkid,
      personId: pickString(c, ["person_id"]),
      trackerId: pickString(c, ["tracker_id"]),
      startTime: String(c.start_time || c.created_at || new Date().toISOString()),
      duration: Number(c.duration || 0),
      callType: String(c.call_type || "unknown"),
      milestones,
    };
  });
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
    url.searchParams.set("fields", CALLRAIL_SOURCE_FIELDS.join(","));
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
  options: CallRailSyncOptions = {},
): Promise<{ synced: number; newCalls: number; updatedCalls: number }> {
  const days = Math.max(1, Math.min(options.days ?? DEFAULT_CALLRAIL_SYNC_DAYS, MAX_CALLRAIL_BACKFILL_DAYS));
  const syncType = options.syncType ?? "calls";
  const createLeadMode = options.createLeadMode === "attribution_only"
    ? "none"
    : options.createLeadMode ?? "none";
  const sinceDate = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

  const syncLog = await db.insert(integrationSyncLogsTable).values({
    tenantId,
    integration: "callrail",
    syncType,
    status: "running",
    startedAt: new Date(),
    triggeredBySyncLogId: options.triggeredBySyncLogId ?? null,
  }).returning();
  const logId = syncLog[0]?.id;

  try {
    const calls = await fetchCallRailCalls(config, sinceDate);

    let newCalls = 0;
    let updatedCalls = 0;
    for (const call of calls) {
      if (!call.id) continue;

      const externalId = `callrail:${call.id}`;
      const existing = await db.select({
        id: attributionEventsTable.id,
        createdLeadId: attributionEventsTable.createdLeadId,
      }).from(attributionEventsTable)
        .where(and(
          eq(attributionEventsTable.tenantId, tenantId),
          eq(attributionEventsTable.externalId, externalId),
        ))
        .limit(1);

      const hashedPhoneValue = call.customerPhoneNumber
        ? hashPhone(call.customerPhoneNumber)
        : null;
      const source = resolvedSource(call);
      const campaign = resolvedCampaign(call);
      const medium = resolvedMedium(call);
      const leadType = resolvedLeadType(call);
      const callTime = parseCallTime(call.startTime);
      const matchLevel: "diamond" | "golden" | "unmatched" = hasAnyClickId(call) ? "diamond" : hashedPhoneValue ? "golden" : "unmatched";
      const matchConfidence = hasAnyClickId(call) ? 1.0 : hashedPhoneValue ? 0.9 : 0;
      const eventValues = {
        tenantId,
        eventType: "call" as const,
        gclid: call.gclid || null,
        fbclid: call.fbclid || null,
        msclkid: call.msclkid || null,
        hashedPhone: hashedPhoneValue,
        utmSource: source,
        utmCampaign: campaign,
        utmMedium: medium,
        utmTerm: call.utmTerm || null,
        utmContent: call.utmContent || null,
        landingPage: call.landingPageUrl || null,
        pageUrl: call.lastRequestedUrl || call.landingPageUrl || null,
        referrer: call.referrer || null,
        formType: "callrail_call",
        formId: call.id,
        formName: call.sourceName || call.formattedTrackingSource || "CallRail call",
        formFields: {
          provider: "callrail",
          callId: call.id,
          customerName: call.customerName,
          trackingPhoneNumber: call.trackingPhoneNumber,
          sourceName: call.sourceName,
          formattedTrackingSource: call.formattedTrackingSource,
          personId: call.personId,
          trackerId: call.trackerId,
          duration: call.duration,
          callType: call.callType,
          milestones: call.milestones,
        },
        submittedAt: callTime,
        createdAt: callTime,
        matchLevel,
        matchConfidence,
        externalId,
      };

      let eventId = existing[0]?.id ?? null;
      if (eventId) {
        await db.update(attributionEventsTable).set(eventValues).where(eq(attributionEventsTable.id, eventId));
        updatedCalls++;
      } else {
        const [insertedEvent] = await db.insert(attributionEventsTable).values(eventValues).returning({
          id: attributionEventsTable.id,
        });
        eventId = insertedEvent?.id ?? null;
        newCalls++;
      }

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

        let leadId = existing[0]?.createdLeadId ?? existingLead[0]?.id ?? null;

        if (!leadId && createLeadMode === "active") {
          const [newLead] = await db.insert(leadsTable).values({
            tenantId,
            firstName,
            lastName,
            phone: normalizedCustomerPhone || null,
            source,
            originalSource: source,
            leadType,
            interestType: null,
            serviceType: "CallRail",
            hubStatus: "day_1",
            status: "new",
            deadReason: null,
            assignedAt: callTime,
            createdAt: callTime,
            updatedAt: callTime,
          }).returning();

          if (newLead) {
            leadId = newLead.id;
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

        if (eventId && leadId) {
          await db.update(attributionEventsTable)
            .set({ createdLeadId: leadId })
            .where(eq(attributionEventsTable.id, eventId));
        }
      }
    }

    if (logId) {
      await db.update(integrationSyncLogsTable)
        .set({ status: "completed", recordsProcessed: calls.length, completedAt: new Date() })
        .where(eq(integrationSyncLogsTable.id, logId));
    }

    console.log(`[CallRail] Synced ${calls.length} calls for tenant ${tenantId} (${newCalls} new, ${updatedCalls} updated)`);
    return { synced: calls.length, newCalls, updatedCalls };
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

function intValue(value: unknown): number {
  return Number(value ?? 0) || 0;
}

function recordValue(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = intValue(raw);
  }
  return out;
}

function sampleValue(value: unknown): CallRailPulseLeadCleanupResult["samples"] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const r = row && typeof row === "object" ? row as Record<string, unknown> : {};
    return {
      id: intValue(r.id),
      name: typeof r.name === "string" ? r.name : "",
      source: typeof r.source === "string" ? r.source : null,
      leadType: typeof r.leadType === "string" ? r.leadType : null,
      serviceType: typeof r.serviceType === "string" ? r.serviceType : null,
      hubStatus: typeof r.hubStatus === "string" ? r.hubStatus : null,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
    };
  });
}

function cleanupResult(
  tenantId: number,
  dryRun: boolean,
  row: Record<string, unknown> | undefined,
): CallRailPulseLeadCleanupResult {
  return {
    tenantId,
    dryRun,
    candidates: intValue(row?.candidates),
    deletedLeads: intValue(row?.deleted_leads),
    attributionEventsUnlinked: intValue(row?.attribution_events_unlinked),
    jobsUnlinked: intValue(row?.jobs_unlinked),
    soldEstimatesUnlinked: intValue(row?.sold_estimates_unlinked),
    podiumMessagesUnlinked: intValue(row?.podium_messages_unlinked),
    scheduledFollowupsDeleted: intValue(row?.scheduled_followups_deleted),
    callAttemptsDeleted: intValue(row?.call_attempts_deleted),
    leadStatusHistoryDeleted: intValue(row?.lead_status_history_deleted),
    leadAssignmentsDeleted: intValue(row?.lead_assignments_deleted),
    leadAttributionCorrectionsDeleted: intValue(row?.lead_attribution_corrections_deleted),
    leadMergeRowsDeleted: intValue(row?.lead_merge_rows_deleted),
    unroutedRowsUnlinked: intValue(row?.unrouted_rows_unlinked),
    samples: sampleValue(row?.samples),
    byHubStatus: recordValue(row?.by_hub_status),
    byStatus: recordValue(row?.by_status),
  };
}

export async function cleanupCallRailPulseLeads(
  tenantId: number,
  options: { dryRun?: boolean } = {},
): Promise<CallRailPulseLeadCleanupResult> {
  const dryRun = options.dryRun !== false;

  if (dryRun) {
    const result = await db.execute(sql`
      WITH candidates AS (
        SELECT DISTINCT
          l.id,
          trim(concat_ws(' ', l.first_name, l.last_name)) AS name,
          l.source,
          l.lead_type,
          l.service_type,
          l.hub_status,
          l.status,
          l.created_at
        FROM leads l
        WHERE l.tenant_id = ${tenantId}
          AND (
            lower(coalesce(l.service_type, '')) LIKE '%callrail%'
            OR lower(coalesce(l.lead_type, '')) LIKE '%callrail%'
            OR lower(coalesce(l.source, '')) LIKE '%callrail%'
            OR lower(coalesce(l.original_source, '')) LIKE '%callrail%'
            OR lower(coalesce(l.dead_reason, '')) LIKE 'callrail_%'
            OR EXISTS (
              SELECT 1
              FROM attribution_events ae
              WHERE ae.tenant_id = l.tenant_id
                AND ae.created_lead_id = l.id
                AND (
                  ae.external_id LIKE 'callrail:%'
                  OR ae.form_type = 'callrail_call'
                  OR ae.form_fields->>'provider' = 'callrail'
                )
                AND abs(extract(epoch FROM (l.created_at - coalesce(ae.submitted_at, ae.created_at)))) <= 600
            )
          )
      ),
      hub_counts AS (
        SELECT hub_status, count(*)::int AS count
        FROM candidates
        GROUP BY hub_status
      ),
      status_counts AS (
        SELECT status, count(*)::int AS count
        FROM candidates
        GROUP BY status
      ),
      sample_rows AS (
        SELECT
          id,
          name,
          source,
          lead_type AS "leadType",
          service_type AS "serviceType",
          hub_status AS "hubStatus",
          created_at AS "createdAt"
        FROM candidates
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      )
      SELECT
        (SELECT count(*)::int FROM candidates) AS candidates,
        0::int AS deleted_leads,
        0::int AS attribution_events_unlinked,
        0::int AS jobs_unlinked,
        0::int AS sold_estimates_unlinked,
        0::int AS podium_messages_unlinked,
        0::int AS scheduled_followups_deleted,
        0::int AS call_attempts_deleted,
        0::int AS lead_status_history_deleted,
        0::int AS lead_assignments_deleted,
        0::int AS lead_attribution_corrections_deleted,
        0::int AS lead_merge_rows_deleted,
        0::int AS unrouted_rows_unlinked,
        coalesce((SELECT json_object_agg(coalesce(hub_status::text, 'none'), count) FROM hub_counts), '{}'::json) AS by_hub_status,
        coalesce((SELECT json_object_agg(coalesce(status::text, 'none'), count) FROM status_counts), '{}'::json) AS by_status,
        coalesce((SELECT json_agg(sample_rows) FROM sample_rows), '[]'::json) AS samples
    `);
    return cleanupResult(tenantId, true, result.rows[0] as Record<string, unknown> | undefined);
  }

  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT DISTINCT
        l.id,
        trim(concat_ws(' ', l.first_name, l.last_name)) AS name,
        l.source,
        l.lead_type,
        l.service_type,
        l.hub_status,
        l.status,
        l.created_at
      FROM leads l
      WHERE l.tenant_id = ${tenantId}
        AND (
          lower(coalesce(l.service_type, '')) LIKE '%callrail%'
          OR lower(coalesce(l.lead_type, '')) LIKE '%callrail%'
          OR lower(coalesce(l.source, '')) LIKE '%callrail%'
          OR lower(coalesce(l.original_source, '')) LIKE '%callrail%'
          OR lower(coalesce(l.dead_reason, '')) LIKE 'callrail_%'
          OR EXISTS (
            SELECT 1
            FROM attribution_events ae
            WHERE ae.tenant_id = l.tenant_id
              AND ae.created_lead_id = l.id
              AND (
                ae.external_id LIKE 'callrail:%'
                OR ae.form_type = 'callrail_call'
                OR ae.form_fields->>'provider' = 'callrail'
              )
              AND abs(extract(epoch FROM (l.created_at - coalesce(ae.submitted_at, ae.created_at)))) <= 600
          )
        )
    ),
    hub_counts AS (
      SELECT hub_status, count(*)::int AS count
      FROM candidates
      GROUP BY hub_status
    ),
    status_counts AS (
      SELECT status, count(*)::int AS count
      FROM candidates
      GROUP BY status
    ),
    sample_rows AS (
      SELECT
        id,
        name,
        source,
        lead_type AS "leadType",
        service_type AS "serviceType",
        hub_status AS "hubStatus",
        created_at AS "createdAt"
      FROM candidates
      ORDER BY created_at DESC, id DESC
      LIMIT 10
    ),
    sync_log AS (
      INSERT INTO integration_sync_logs (
        tenant_id,
        integration,
        sync_type,
        status,
        started_at,
        records_processed
      )
      VALUES (
        ${tenantId},
        'callrail',
        'pulse_lead_cleanup',
        'running',
        now(),
        (SELECT count(*)::int FROM candidates)
      )
      RETURNING id
    ),
    attribution_events_unlinked AS (
      UPDATE attribution_events
      SET created_lead_id = NULL
      WHERE created_lead_id IN (SELECT id FROM candidates)
      RETURNING 1
    ),
    jobs_unlinked AS (
      UPDATE jobs
      SET lead_id = NULL, updated_at = now()
      WHERE lead_id IN (SELECT id FROM candidates)
      RETURNING 1
    ),
    sold_estimates_unlinked AS (
      UPDATE sold_estimates
      SET lead_id = NULL, updated_at = now()
      WHERE lead_id IN (SELECT id FROM candidates)
      RETURNING 1
    ),
    podium_messages_unlinked AS (
      UPDATE podium_messages
      SET lead_id = NULL
      WHERE lead_id IN (SELECT id FROM candidates)
      RETURNING 1
    ),
    unrouted_rows_unlinked AS (
      UPDATE unrouted_sheet_rows
      SET resolved_lead_id = NULL, resolved_via = NULL
      WHERE resolved_lead_id IN (SELECT id FROM candidates)
      RETURNING 1
    ),
    scheduled_followups_deleted AS (
      DELETE FROM scheduled_followups
      WHERE lead_id IN (SELECT id FROM candidates)
      RETURNING 1
    ),
    call_attempts_deleted AS (
      DELETE FROM call_attempts
      WHERE lead_id IN (SELECT id FROM candidates)
      RETURNING 1
    ),
    lead_attribution_corrections_deleted AS (
      DELETE FROM lead_attribution_corrections
      WHERE lead_id IN (SELECT id FROM candidates)
      RETURNING 1
    ),
    lead_status_history_deleted AS (
      DELETE FROM lead_status_history
      WHERE lead_id IN (SELECT id FROM candidates)
      RETURNING 1
    ),
    lead_assignments_deleted AS (
      DELETE FROM lead_assignments
      WHERE lead_id IN (SELECT id FROM candidates)
      RETURNING 1
    ),
    lead_merge_rows_deleted AS (
      DELETE FROM lead_merges
      WHERE duplicate_lead_id IN (SELECT id FROM candidates)
         OR canonical_lead_id IN (SELECT id FROM candidates)
      RETURNING 1
    ),
    deleted_leads AS (
      DELETE FROM leads
      WHERE id IN (SELECT id FROM candidates)
      RETURNING id
    ),
    completed_log AS (
      UPDATE integration_sync_logs
      SET
        status = 'completed',
        records_processed = (SELECT count(*)::int FROM deleted_leads),
        completed_at = now(),
        error_message = NULL,
        error_code = NULL
      WHERE id = (SELECT id FROM sync_log)
      RETURNING id
    )
    SELECT
      (SELECT count(*)::int FROM candidates) AS candidates,
      (SELECT count(*)::int FROM deleted_leads) AS deleted_leads,
      (SELECT count(*)::int FROM attribution_events_unlinked) AS attribution_events_unlinked,
      (SELECT count(*)::int FROM jobs_unlinked) AS jobs_unlinked,
      (SELECT count(*)::int FROM sold_estimates_unlinked) AS sold_estimates_unlinked,
      (SELECT count(*)::int FROM podium_messages_unlinked) AS podium_messages_unlinked,
      (SELECT count(*)::int FROM scheduled_followups_deleted) AS scheduled_followups_deleted,
      (SELECT count(*)::int FROM call_attempts_deleted) AS call_attempts_deleted,
      (SELECT count(*)::int FROM lead_status_history_deleted) AS lead_status_history_deleted,
      (SELECT count(*)::int FROM lead_assignments_deleted) AS lead_assignments_deleted,
      (SELECT count(*)::int FROM lead_attribution_corrections_deleted) AS lead_attribution_corrections_deleted,
      (SELECT count(*)::int FROM lead_merge_rows_deleted) AS lead_merge_rows_deleted,
      (SELECT count(*)::int FROM unrouted_rows_unlinked) AS unrouted_rows_unlinked,
      coalesce((SELECT json_object_agg(coalesce(hub_status::text, 'none'), count) FROM hub_counts), '{}'::json) AS by_hub_status,
      coalesce((SELECT json_object_agg(coalesce(status::text, 'none'), count) FROM status_counts), '{}'::json) AS by_status,
      coalesce((SELECT json_agg(sample_rows) FROM sample_rows), '[]'::json) AS samples
  `);

  return cleanupResult(tenantId, false, result.rows[0] as Record<string, unknown> | undefined);
}
