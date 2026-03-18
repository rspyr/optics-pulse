import { db, jobsTable, attributionEventsTable, leadsTable, tenantsTable, reconciliationRunsTable } from "@workspace/db";
import { eq, and, isNull, isNotNull, desc } from "drizzle-orm";
import crypto from "crypto";

function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\+]/g, "").replace(/^1/, "");
}

function normalizeAddress(address: string): string {
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

  const jobConditions = [isNull(jobsTable.matchLevel), eq(jobsTable.status, "completed")];
  if (tenantId) jobConditions.push(eq(jobsTable.tenantId, tenantId));
  const unmatchedJobs = await db.select().from(jobsTable).where(and(...jobConditions));

  for (const job of unmatchedJobs) {
    let matched = false;
    let matchedGclid: string | null = null;

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
        if (matchedGclid && job.revenue > 0) {
          ociPayloads.push(buildOciPayload(matchedGclid, job.id, job.tenantId, job.revenue, job.completedAt));
        }
        continue;
      }
    }

    const gclidEvents = await db.select().from(attributionEventsTable)
      .where(and(
        eq(attributionEventsTable.tenantId, job.tenantId),
        isNotNull(attributionEventsTable.gclid)
      ));

    const nameParts = job.customerName.split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    const leads = await db.select().from(leadsTable)
      .where(and(eq(leadsTable.tenantId, job.tenantId), eq(leadsTable.firstName, firstName)))
      .limit(20);

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
          matched = true;
          if (matchedGclid && job.revenue > 0) {
            ociPayloads.push(buildOciPayload(matchedGclid, job.id, job.tenantId, job.revenue, job.completedAt));
          }
          break;
        }
      }
    }

    if (matched) continue;

    const addressLeads = await db.select().from(leadsTable)
      .where(and(eq(leadsTable.tenantId, job.tenantId), eq(leadsTable.lastName, lastName)))
      .limit(20);

    let bronzeMatched = false;
    for (const addrLead of addressLeads) {
      if (!addrLead.lastName || addrLead.lastName.toLowerCase() !== lastName.toLowerCase()) continue;

      const addressEvents = await db.select().from(attributionEventsTable)
        .where(and(
          eq(attributionEventsTable.tenantId, job.tenantId),
          isNotNull(attributionEventsTable.billingAddress)
        ))
        .limit(20);

      for (const addrEvent of addressEvents) {
        if (!addrEvent.billingAddress) continue;
        const normalizedEventAddr = normalizeAddress(addrEvent.billingAddress);
        const lastNameInAddr = normalizedEventAddr.includes(lastName.toLowerCase());
        if (!lastNameInAddr) continue;

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
        bronzeMatched = true;
        if (matchedGclid && job.revenue > 0) {
          ociPayloads.push(buildOciPayload(matchedGclid, job.id, job.tenantId, job.revenue, job.completedAt));
        }
        break;
      }
      if (bronzeMatched) break;
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

  for (const payload of ociPayloads) {
    console.log(`[OCI] Conversion ready for upload: GCLID=${payload.gclid}, Value=$${payload.conversionValue}, Job=${payload.jobId}`);
  }

  console.log(`[Reconciliation] ${triggerType} run complete: ${jobsProcessed} jobs processed, ${totalMatched} matched (${matchRate}% rate)`);
  console.log(`[Reconciliation] Breakdown: ${results.diamond} diamond, ${results.golden} golden, ${results.silver} silver, ${results.bronze} bronze, ${results.unmatched} unmatched`);
  if (ociPayloads.length > 0) {
    console.log(`[OCI] ${ociPayloads.length} conversion payload(s) ready for Google Ads upload`);
  }

  return {
    tenantId,
    jobsProcessed,
    ...results,
    matchRate,
    ociPayloads,
  };
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

  return {
    latestRun: latestRun || null,
    recentRuns: allRuns,
    nextScheduledRun: getNextScheduledTime(),
  };
}

function getNextScheduledTime(): string {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
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
