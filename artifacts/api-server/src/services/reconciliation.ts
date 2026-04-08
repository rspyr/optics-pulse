import { db, jobsTable, attributionEventsTable, leadsTable, tenantsTable, reconciliationRunsTable, integrationSyncLogsTable } from "@workspace/db";
import { eq, and, or, isNull, isNotNull, desc } from "drizzle-orm";
import crypto from "crypto";
import { decryptConfig } from "../lib/encryption";
import { uploadOfflineConversions, uploadEnhancedConversions } from "./integrations/google-ads";
import { sendCAPIEvents, buildCAPILeadEvent } from "./integrations/meta";
import { patchJobCustomField } from "./integrations/service-titan";

export function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\+]/g, "").replace(/^1/, "");
}

export function normalizeAddress(address: string): string {
  return address
    .trim()
    .toLowerCase()
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\broad\b/g, "rd")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\blane\b/g, "ln")
    .replace(/\bcourt\b/g, "ct")
    .replace(/\bapartment\b/g, "apt")
    .replace(/\bsuite\b/g, "ste")
    .replace(/[.,#]/g, "")
    .replace(/\s+/g, " ");
}

export interface ReconciliationResult {
  tenantId: number | null;
  jobsProcessed: number;
  diamond: number;
  golden: number;
  silver: number;
  bronze: number;
  unmatched: number;
  matchRate: number;
  ociPayloads: OciPayload[];
}

export interface OciPayload {
  gclid: string;
  conversionAction: string;
  conversionDateTime: string;
  conversionValue: number;
  currencyCode: string;
  jobId: number;
  tenantId: number;
}

export async function runReconciliation(tenantId: number | null, triggerType: "manual" | "scheduled" = "manual"): Promise<ReconciliationResult> {
  const startedAt = new Date();
  const results = { diamond: 0, golden: 0, silver: 0, bronze: 0, unmatched: 0 };
  const ociPayloads: OciPayload[] = [];
  const allMatchedJobIds: number[] = [];

  const matchCondition = or(isNull(jobsTable.matchLevel), eq(jobsTable.matchLevel, "unmatched"));
  const baseConditions = [matchCondition, eq(jobsTable.status, "completed"), isNotNull(jobsTable.customerName)];
  if (tenantId) baseConditions.push(eq(jobsTable.tenantId, tenantId));
  const unmatchedJobs = await db.select({
    id: jobsTable.id,
    tenantId: jobsTable.tenantId,
    customerName: jobsTable.customerName,
    matchedGclid: jobsTable.matchedGclid,
    serviceAddress: jobsTable.serviceAddress,
    revenue: jobsTable.revenue,
    completedAt: jobsTable.completedAt,
    stJobId: jobsTable.stJobId,
    status: jobsTable.status,
    matchLevel: jobsTable.matchLevel,
  }).from(jobsTable).where(and(...baseConditions));

  for (const job of unmatchedJobs) {
    let matched = false;
    let matchedGclid: string | null = null;

    const nameParts = (job.customerName || "").split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    if (job.matchedGclid) {
      const [event] = await db.select().from(attributionEventsTable)
        .where(and(
          eq(attributionEventsTable.gclid, job.matchedGclid),
          eq(attributionEventsTable.tenantId, job.tenantId)
        ))
        .limit(1);
      if (event) {
        matchedGclid = job.matchedGclid;
        await db.update(jobsTable).set({
          matchLevel: "diamond",
          updatedAt: new Date(),
        }).where(eq(jobsTable.id, job.id));
        await db.update(attributionEventsTable).set({
          matchLevel: "diamond",
          matchConfidence: 1.0,
        }).where(eq(attributionEventsTable.id, event.id));
        results.diamond++;
        allMatchedJobIds.push(job.id);
        if (matchedGclid && job.revenue > 0) {
          ociPayloads.push(buildOciPayload(matchedGclid, job.id, job.tenantId, job.revenue, job.completedAt));
        }
        continue;
      }
    }

    const leadConditions = [eq(leadsTable.tenantId, job.tenantId), eq(leadsTable.firstName, firstName)];
    if (lastName) leadConditions.push(eq(leadsTable.lastName, lastName));
    const matchingLeads = await db.select().from(leadsTable)
      .where(and(...leadConditions))
      .limit(20);

    let diamondViaLead = false;
    for (const lead of matchingLeads) {
      if (!lead.matchedGclid) continue;
      const [gclidEvent] = await db.select().from(attributionEventsTable)
        .where(and(
          eq(attributionEventsTable.tenantId, job.tenantId),
          eq(attributionEventsTable.gclid, lead.matchedGclid)
        ))
        .limit(1);
      if (gclidEvent) {
        matchedGclid = lead.matchedGclid;
        await db.update(jobsTable).set({
          matchLevel: "diamond",
          matchedGclid: matchedGclid,
          updatedAt: new Date(),
        }).where(eq(jobsTable.id, job.id));
        await db.update(attributionEventsTable).set({
          matchLevel: "diamond",
          matchConfidence: 1.0,
        }).where(eq(attributionEventsTable.id, gclidEvent.id));
        results.diamond++;
        allMatchedJobIds.push(job.id);
        diamondViaLead = true;
        if (matchedGclid && job.revenue > 0) {
          ociPayloads.push(buildOciPayload(matchedGclid, job.id, job.tenantId, job.revenue, job.completedAt));
        }
        break;
      }
    }
    if (diamondViaLead) continue;

    const leads = matchingLeads;

    for (const lead of leads) {
      if (lead.phone) {
        const normalizedPhone = normalizePhone(lead.phone);
        const hashedPhone = hashValue(normalizedPhone);
        const [phoneEvent] = await db.select().from(attributionEventsTable)
          .where(and(
            eq(attributionEventsTable.tenantId, job.tenantId),
            eq(attributionEventsTable.hashedPhone, hashedPhone)
          ))
          .limit(1);
        if (phoneEvent) {
          matchedGclid = phoneEvent.gclid || null;
          await db.update(jobsTable).set({
            matchLevel: "golden",
            matchedGclid: matchedGclid,
            updatedAt: new Date(),
          }).where(eq(jobsTable.id, job.id));
          await db.update(attributionEventsTable).set({
            matchLevel: "golden",
            matchConfidence: 0.9,
          }).where(eq(attributionEventsTable.id, phoneEvent.id));
          results.golden++;
          allMatchedJobIds.push(job.id);
          matched = true;
          if (matchedGclid && job.revenue > 0) {
            ociPayloads.push(buildOciPayload(matchedGclid, job.id, job.tenantId, job.revenue, job.completedAt));
          }
          break;
        }
      }

      if (lead.email) {
        const hashedEmail = hashValue(lead.email);
        const [emailEvent] = await db.select().from(attributionEventsTable)
          .where(and(
            eq(attributionEventsTable.tenantId, job.tenantId),
            eq(attributionEventsTable.hashedEmail, hashedEmail)
          ))
          .limit(1);
        if (emailEvent) {
          matchedGclid = emailEvent.gclid || null;
          await db.update(jobsTable).set({
            matchLevel: "silver",
            matchedGclid: matchedGclid,
            updatedAt: new Date(),
          }).where(eq(jobsTable.id, job.id));
          await db.update(attributionEventsTable).set({
            matchLevel: "silver",
            matchConfidence: 0.8,
          }).where(eq(attributionEventsTable.id, emailEvent.id));
          results.silver++;
          allMatchedJobIds.push(job.id);
          matched = true;
          if (matchedGclid && job.revenue > 0) {
            ociPayloads.push(buildOciPayload(matchedGclid, job.id, job.tenantId, job.revenue, job.completedAt));
          }
          break;
        }
      }
    }

    if (matched) continue;

    let bronzeMatched = false;
    if (job.serviceAddress) {
      const normalizedJobAddr = normalizeAddress(job.serviceAddress);

      const addressEvents = await db.select().from(attributionEventsTable)
        .where(and(
          eq(attributionEventsTable.tenantId, job.tenantId),
          isNotNull(attributionEventsTable.billingAddress)
        ))
        .limit(50);

      for (const addrEvent of addressEvents) {
        if (!addrEvent.billingAddress) continue;
        const normalizedEventAddr = normalizeAddress(addrEvent.billingAddress);
        if (normalizedJobAddr !== normalizedEventAddr) continue;

        matchedGclid = addrEvent.gclid || null;
        await db.update(jobsTable).set({
          matchLevel: "bronze",
          matchedGclid: matchedGclid,
          updatedAt: new Date(),
        }).where(eq(jobsTable.id, job.id));
        await db.update(attributionEventsTable).set({
          matchLevel: "bronze",
          matchConfidence: 0.6,
        }).where(eq(attributionEventsTable.id, addrEvent.id));
        results.bronze++;
        allMatchedJobIds.push(job.id);
        bronzeMatched = true;
        if (matchedGclid && job.revenue > 0) {
          ociPayloads.push(buildOciPayload(matchedGclid, job.id, job.tenantId, job.revenue, job.completedAt));
        }
        break;
      }
    }
    if (bronzeMatched) continue;

    await db.update(jobsTable).set({ matchLevel: "unmatched", updatedAt: new Date() }).where(eq(jobsTable.id, job.id));
    results.unmatched++;
  }

  const totalMatched = results.diamond + results.golden + results.silver + results.bronze;
  const jobsProcessed = unmatchedJobs.length;
  const matchRate = jobsProcessed > 0 ? Math.round((totalMatched / jobsProcessed) * 100 * 10) / 10 : 0;

  await db.insert(reconciliationRunsTable).values({
    tenantId,
    jobsProcessed,
    diamondMatches: results.diamond,
    goldenMatches: results.golden,
    silverMatches: results.silver,
    bronzeMatches: results.bronze,
    unmatchedCount: results.unmatched,
    matchRate,
    triggerType,
    status: "completed",
    startedAt,
    completedAt: new Date(),
  });

  console.log(`[Reconciliation] ${triggerType} run complete: ${jobsProcessed} jobs processed, ${totalMatched} matched (${matchRate}% rate)`);
  console.log(`[Reconciliation] Breakdown: ${results.diamond} diamond, ${results.golden} golden, ${results.silver} silver, ${results.bronze} bronze, ${results.unmatched} unmatched`);

  if ((ociPayloads.length > 0 || allMatchedJobIds.length > 0) && tenantId) {
    const jobIdsToFetch = [...new Set([...ociPayloads.map((p) => p.jobId), ...allMatchedJobIds])];
    const matchedJobRows = await db.select().from(jobsTable).where(
      and(eq(jobsTable.tenantId, tenantId), or(...jobIdsToFetch.map((id) => eq(jobsTable.id, id)))),
    );
    await pushConversionsToExternalAPIs(tenantId, ociPayloads, matchedJobRows);
  }

  return {
    tenantId,
    jobsProcessed,
    ...results,
    matchRate,
    ociPayloads,
  };
}

interface TenantApiConfig {
  serviceTitanClientId?: string;
  serviceTitanClientSecret?: string;
  serviceTitanTenantId?: string;
  googleAdsApiKey?: string;
  googleAdsAccessToken?: string;
  googleAdsDeveloperToken?: string;
  googleAdsCustomerId?: string;
  googleAdsLoginCustomerId?: string;
  googleAdsRefreshToken?: string;
  googleAdsClientId?: string;
  googleAdsClientSecret?: string;
  metaAccessToken?: string;
  metaAdAccountId?: string;
  metaPixelId?: string;
}

function getTenantApiConfig(tenant: typeof tenantsTable.$inferSelect): TenantApiConfig | null {
  if (!tenant.apiConfig || typeof tenant.apiConfig !== "string") return null;
  try {
    return decryptConfig(tenant.apiConfig) as TenantApiConfig;
  } catch {
    return null;
  }
}

async function pushConversionsToExternalAPIs(
  tenantId: number,
  ociPayloads: OciPayload[],
  matchedJobs: Array<{ id: number; stJobId: string | null; matchedGclid: string | null; revenue: number; customerName: string | null; completedAt: Date | null }>,
): Promise<void> {
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return;

  const config = getTenantApiConfig(tenant);
  if (!config) {
    console.log(`[Outbound] No API config for tenant ${tenantId}, skipping outbound push`);
    return;
  }

  const hasGoogleAdsCredentials = (config.googleAdsApiKey || (config.googleAdsRefreshToken && config.googleAdsClientId && config.googleAdsClientSecret));
  if (hasGoogleAdsCredentials && config.googleAdsCustomerId && config.googleAdsDeveloperToken && ociPayloads.length > 0) {
    const startedAt = new Date();
    try {
      const gaConfig = {
        developerToken: config.googleAdsDeveloperToken!,
        accessToken: config.googleAdsApiKey || "",
        refreshToken: config.googleAdsRefreshToken,
        clientId: config.googleAdsClientId,
        clientSecret: config.googleAdsClientSecret,
        customerId: config.googleAdsCustomerId,
        loginCustomerId: config.googleAdsLoginCustomerId,
      };
      const conversionAction = `customers/${config.googleAdsCustomerId.replace(/-/g, "")}/conversionActions/ServiceTitan_Installation_Revenue`;
      const result = await uploadOfflineConversions(gaConfig, ociPayloads, conversionAction);
      await db.insert(integrationSyncLogsTable).values({
        tenantId,
        integration: "google_ads",
        syncType: "oci_upload",
        status: result.errorCount > 0 ? "partial" : "completed",
        recordsProcessed: result.successCount,
        errorMessage: result.errors.length > 0 ? result.errors.join("; ") : null,
        startedAt,
        completedAt: new Date(),
      });
      console.log(`[Outbound] Google Ads OCI: ${result.successCount} uploaded, ${result.errorCount} errors for tenant ${tenantId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.insert(integrationSyncLogsTable).values({
        tenantId,
        integration: "google_ads",
        syncType: "oci_upload",
        status: "error",
        recordsProcessed: 0,
        errorMessage: message,
        startedAt,
        completedAt: new Date(),
      });
      console.error(`[Outbound] Google Ads OCI error for tenant ${tenantId}:`, message);
    }
  }

  const accessToken = config.googleAdsAccessToken || config.googleAdsApiKey || "";
  if ((accessToken || hasGoogleAdsCredentials) && config.googleAdsCustomerId && config.googleAdsDeveloperToken) {
    const nonGclidJobs = matchedJobs.filter(j => !j.matchedGclid && j.revenue > 0);
    if (nonGclidJobs.length > 0) {
      const startedAt = new Date();
      try {
        const gaConfig = {
          developerToken: config.googleAdsDeveloperToken,
          accessToken,
          refreshToken: config.googleAdsRefreshToken,
          clientId: config.googleAdsClientId,
          clientSecret: config.googleAdsClientSecret,
          customerId: config.googleAdsCustomerId,
          loginCustomerId: config.googleAdsLoginCustomerId,
        };

        const enhancedPayloads: Array<{
          conversionAction: string;
          conversionDateTime: string;
          conversionValue: number;
          currencyCode: string;
          hashedEmail?: string;
          hashedPhone?: string;
        }> = [];
        for (const job of nonGclidJobs) {
          const nameParts = (job.customerName || "").split(" ");
          const leads = await db.select().from(leadsTable)
            .where(and(eq(leadsTable.tenantId, tenantId), eq(leadsTable.firstName, nameParts[0] || "")))
            .limit(1);
          const lead = leads[0];
          if (lead && (lead.email || lead.phone)) {
            enhancedPayloads.push({
              conversionAction: `customers/${config.googleAdsCustomerId!.replace(/-/g, "")}/conversionActions/ServiceTitan_Installation_Revenue`,
              conversionDateTime: (job.completedAt || new Date()).toISOString().replace("T", " ").replace("Z", "+00:00"),
              conversionValue: job.revenue,
              currencyCode: "USD",
              ...(lead.email ? { hashedEmail: hashValue(lead.email) } : {}),
              ...(lead.phone ? { hashedPhone: hashValue(normalizePhone(lead.phone)) } : {}),
            });
          }
        }

        if (enhancedPayloads.length > 0) {
          const result = await uploadEnhancedConversions(gaConfig, enhancedPayloads);
          await db.insert(integrationSyncLogsTable).values({
            tenantId,
            integration: "google_ads",
            syncType: "enhanced_conversions",
            status: result.errorCount > 0 ? "partial" : "completed",
            recordsProcessed: result.successCount,
            errorMessage: result.errors.length > 0 ? result.errors.join("; ") : null,
            startedAt,
            completedAt: new Date(),
          });
          console.log(`[Outbound] Enhanced Conversions: ${result.successCount} uploaded for tenant ${tenantId}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db.insert(integrationSyncLogsTable).values({
          tenantId,
          integration: "google_ads",
          syncType: "enhanced_conversions",
          status: "error",
          recordsProcessed: 0,
          errorMessage: message,
          startedAt,
          completedAt: new Date(),
        });
        console.error(`[Outbound] Enhanced Conversions error for tenant ${tenantId}:`, message);
      }
    }
  }

  if (config.metaAccessToken && config.metaPixelId) {
    const startedAt = new Date();
    try {
      const capiEvents = ociPayloads.map((p) =>
        buildCAPILeadEvent(null, null, p.conversionValue, new Date(p.conversionDateTime)),
      );
      const result = await sendCAPIEvents(
        { accessToken: config.metaAccessToken, adAccountId: config.metaAdAccountId || "", pixelId: config.metaPixelId },
        capiEvents,
      );
      await db.insert(integrationSyncLogsTable).values({
        tenantId,
        integration: "meta",
        syncType: "capi_upload",
        status: "completed",
        recordsProcessed: result.eventsReceived,
        startedAt,
        completedAt: new Date(),
      });
      console.log(`[Outbound] Meta CAPI: ${result.eventsReceived} events sent for tenant ${tenantId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.insert(integrationSyncLogsTable).values({
        tenantId,
        integration: "meta",
        syncType: "capi_upload",
        status: "error",
        recordsProcessed: 0,
        errorMessage: message,
        startedAt,
        completedAt: new Date(),
      });
      console.error(`[Outbound] Meta CAPI error for tenant ${tenantId}:`, message);
    }
  }

  if (config.serviceTitanClientId && config.serviceTitanClientSecret && !tenant.stSyncPaused) {
    const stConfig = {
      clientId: config.serviceTitanClientId,
      clientSecret: config.serviceTitanClientSecret,
      tenantId: config.serviceTitanTenantId || tenant.serviceTitanId || "",
    };
    let patchCount = 0;
    for (const job of matchedJobs) {
      if (job.stJobId && job.matchedGclid) {
        try {
          await patchJobCustomField(stConfig, Number(job.stJobId), "Attribution_GCLID", job.matchedGclid);
          patchCount++;
        } catch (err) {
          console.error(`[Outbound] ServiceTitan PATCH error for job ${job.stJobId}:`, err instanceof Error ? err.message : err);
        }
      }
    }
    if (patchCount > 0) {
      await db.insert(integrationSyncLogsTable).values({
        tenantId,
        integration: "service_titan",
        syncType: "attribution_writeback",
        status: "completed",
        recordsProcessed: patchCount,
        startedAt: new Date(),
        completedAt: new Date(),
      });
      console.log(`[Outbound] ServiceTitan: patched ${patchCount} jobs with GCLID for tenant ${tenantId}`);
    }
  }
}

function buildOciPayload(gclid: string, jobId: number, tenantId: number, revenue: number, completedAt: Date | null): OciPayload {
  const conversionTime = completedAt || new Date();
  return {
    gclid,
    conversionAction: "ServiceTitan_Installation_Revenue",
    conversionDateTime: conversionTime.toISOString().replace("T", " ").replace("Z", "+00:00"),
    conversionValue: revenue,
    currencyCode: "USD",
    jobId,
    tenantId,
  };
}

let _nextScheduledRunGetter: (() => string) | null = null;

export function setNextScheduledRunGetter(getter: () => string) {
  _nextScheduledRunGetter = getter;
}

export async function getReconciliationStatus(tenantId: number | null) {
  const conditions = tenantId ? eq(reconciliationRunsTable.tenantId, tenantId) : undefined;

  const [latestRun] = await db.select()
    .from(reconciliationRunsTable)
    .where(conditions)
    .orderBy(desc(reconciliationRunsTable.createdAt))
    .limit(1);

  const allRuns = await db.select()
    .from(reconciliationRunsTable)
    .where(conditions)
    .orderBy(desc(reconciliationRunsTable.createdAt))
    .limit(10);

  const nextScheduledRun = _nextScheduledRunGetter ? _nextScheduledRunGetter() : new Date().toISOString();

  return {
    latestRun: latestRun || null,
    recentRuns: allRuns,
    nextScheduledRun,
  };
}

export async function runScheduledReconciliation(): Promise<ReconciliationResult[]> {
  const tenants = await db.select({ id: tenantsTable.id }).from(tenantsTable);
  const results: ReconciliationResult[] = [];

  for (const tenant of tenants) {
    try {
      const result = await runReconciliation(tenant.id, "scheduled");
      results.push(result);
    } catch (err) {
      console.error(`[Reconciliation] Error processing tenant ${tenant.id}:`, err);
      await db.insert(reconciliationRunsTable).values({
        tenantId: tenant.id,
        jobsProcessed: 0,
        diamondMatches: 0,
        goldenMatches: 0,
        silverMatches: 0,
        bronzeMatches: 0,
        unmatchedCount: 0,
        matchRate: 0,
        triggerType: "scheduled",
        status: "error",
        errorMessage: err instanceof Error ? err.message : "Unknown error",
        startedAt: new Date(),
        completedAt: new Date(),
      });
    }
  }

  return results;
}
