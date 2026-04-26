import { Router, type IRouter } from "express";
import { db, attributionEventsTable, reconciliationRunsTable, jobsTable, leadsTable } from "@workspace/db";
import { eq, and, or, count, desc, sql, SQL } from "drizzle-orm";
import { ListAttributionEventsQueryParams } from "@workspace/api-zod";
import { runReconciliation, getReconciliationStatus } from "../services/reconciliation";
import { requireRole, denyClientUser } from "../middleware/auth";
import { hashValue, hashPhone } from "../lib/phone-utils";
import { extractFieldNamesForOperator, computeUnmatchedReason, extractPiiFromFields } from "./tracker";

const router: IRouter = Router();

router.use("/attribution", denyClientUser);

router.get("/attribution/events", async (req, res) => {
  const query = ListAttributionEventsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  if (query.tenantId) conditions.push(eq(attributionEventsTable.tenantId, query.tenantId));
  if (query.matchLevel) {
    const level = query.matchLevel as "diamond" | "golden" | "silver" | "bronze" | "unmatched";
    conditions.push(eq(attributionEventsTable.matchLevel, level));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const [events, [totalResult]] = await Promise.all([
    db.select().from(attributionEventsTable).where(where).orderBy(desc(attributionEventsTable.createdAt)).limit(limit).offset(offset),
    db.select({ count: count() }).from(attributionEventsTable).where(where),
  ]);

  res.json({ events, total: totalResult.count });
});

router.get("/attribution/events/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid event ID" });
      return;
    }

    const role = req.session.userRole;
    const userTenantId = req.session.tenantId;

    const conditions: SQL[] = [eq(attributionEventsTable.id, id)];
    if (role !== "super_admin" && role !== "agency_user") {
      if (!userTenantId) {
        res.status(403).json({ error: "No tenant assigned" });
        return;
      }
      conditions.push(eq(attributionEventsTable.tenantId, userTenantId));
    }

    const [event] = await db.select().from(attributionEventsTable).where(and(...conditions)).limit(1);
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    type MatchedJobRow = { id: number; customerName: string | null; stJobId: string | null; matchLevel: string | null; matchedGclid: string | null; revenue: number; leadId: number | null; ociUploadedAt: Date | null; enhancedConversionUploadedAt: Date | null; capiUploadedAt: Date | null };
    let matchedJob: MatchedJobRow | null = null;
    let matchedLead: { id: number; firstName: string; lastName: string } | null = null;

    const jobSelect = {
      id: jobsTable.id,
      customerName: jobsTable.customerName,
      stJobId: jobsTable.stJobId,
      matchLevel: jobsTable.matchLevel,
      matchedGclid: jobsTable.matchedGclid,
      revenue: jobsTable.revenue,
      leadId: jobsTable.leadId,
      ociUploadedAt: jobsTable.ociUploadedAt,
      enhancedConversionUploadedAt: jobsTable.enhancedConversionUploadedAt,
      capiUploadedAt: jobsTable.capiUploadedAt,
    };


    if (event.gclid) {
      const [job] = await db.select(jobSelect).from(jobsTable)
        .where(and(eq(jobsTable.tenantId, event.tenantId), eq(jobsTable.matchedGclid, event.gclid)))
        .limit(1);
      if (job) matchedJob = job;
    }

    if (!matchedJob && event.hashedPhone) {
      const leads = await db.select({
        id: leadsTable.id,
        phone: leadsTable.phone,
        firstName: leadsTable.firstName,
        lastName: leadsTable.lastName,
      }).from(leadsTable).where(eq(leadsTable.tenantId, event.tenantId));

      for (const lead of leads) {
        if (lead.phone && hashPhone(lead.phone) === event.hashedPhone) {
          const [job] = await db.select(jobSelect).from(jobsTable)
            .where(and(eq(jobsTable.tenantId, event.tenantId), eq(jobsTable.leadId, lead.id), eq(jobsTable.matchLevel, "golden")))
            .limit(1);
          if (job) {
            matchedJob = job;
            matchedLead = { id: lead.id, firstName: lead.firstName, lastName: lead.lastName };
            break;
          }
        }
      }
    }

    if (!matchedJob && event.hashedEmail) {
      const leads = await db.select({
        id: leadsTable.id,
        email: leadsTable.email,
        firstName: leadsTable.firstName,
        lastName: leadsTable.lastName,
      }).from(leadsTable).where(eq(leadsTable.tenantId, event.tenantId));

      for (const lead of leads) {
        if (lead.email && hashValue(lead.email) === event.hashedEmail) {
          const [job] = await db.select(jobSelect).from(jobsTable)
            .where(and(eq(jobsTable.tenantId, event.tenantId), eq(jobsTable.leadId, lead.id), eq(jobsTable.matchLevel, "silver")))
            .limit(1);
          if (job) {
            matchedJob = job;
            matchedLead = { id: lead.id, firstName: lead.firstName, lastName: lead.lastName };
            break;
          }
        }
      }
    }

    if (!matchedJob && event.billingAddress) {
      const normalizeAddress = (a: string) => a.trim().toLowerCase()
        .replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave")
        .replace(/\bdrive\b/g, "dr").replace(/\broad\b/g, "rd")
        .replace(/\bboulevard\b/g, "blvd").replace(/\blane\b/g, "ln")
        .replace(/\bcourt\b/g, "ct").replace(/\bplace\b/g, "pl")
        .replace(/[.,#]/g, "").replace(/\s+/g, " ");

      const normalizedEventAddr = normalizeAddress(event.billingAddress);
      const jobs = await db.select({
        ...jobSelect,
        serviceAddress: jobsTable.serviceAddress,
      }).from(jobsTable)
        .where(and(eq(jobsTable.tenantId, event.tenantId), eq(jobsTable.matchLevel, "bronze")));

      for (const job of jobs) {
        if (job.serviceAddress && normalizeAddress(job.serviceAddress) === normalizedEventAddr) {
          matchedJob = job;
          break;
        }
      }
    }

    if (!matchedLead && matchedJob?.leadId) {
      const [lead] = await db.select({
        id: leadsTable.id,
        firstName: leadsTable.firstName,
        lastName: leadsTable.lastName,
      }).from(leadsTable).where(eq(leadsTable.id, matchedJob.leadId)).limit(1);
      if (lead) matchedLead = lead;
    }

    // Surface the same redacted field-name list + unmatched reason that
    // the live socket emit exposes, so operators can backfill mapping
    // rules from any past unmatched fill — not just one they happened to
    // be watching live. Helpers are shared with /collect/submit in
    // tracker.ts.
    //
    // The unmatched reason is now persisted on the event row at insert
    // time (column `unmatched_reason`, migration 0042) so historical
    // detail loads return the exact wording the event was originally
    // classified with — important for audit trails and old screenshots
    // that would otherwise silently re-explain themselves if the
    // heuristic is later reworded.
    //
    // For legacy rows written before that column existed, the value will
    // be null and we recompute on the fly as a fallback. The fallback
    // mirrors the live flow's signal sources: phone/email come from the
    // *captured* (pre-hash) values (`!!pii.phone`), not just the hashed
    // columns, otherwise we would lose the "phone/email captured but
    // matcher produced no hash" reason. We re-derive raw PII from the
    // stored form fields using the same helper the live submit handler
    // uses (extractPiiFromFields). The only remaining gap vs. live is
    // that the live flow runs the richer detectFields() pipeline (which
    // can pick up tenant-specific aliases on top of extractPiiFromFields)
    // — that gap is now bounded to legacy rows only.
    const formFieldsRecord = (event.formFields ?? null) as Record<string, unknown> | null;
    const fieldNames = extractFieldNamesForOperator(formFieldsRecord);
    // Defensive: matched events should never surface an "unmatched reason"
    // even if a stale stored value somehow exists on the row. This keeps
    // the response contract clean for matched rows regardless of how the
    // column was written historically.
    let unmatchedReason: string | null = null;
    if (event.matchLevel === "unmatched") {
      unmatchedReason = event.unmatchedReason ?? null;
      if (unmatchedReason === null) {
        const piiFromStoredFields = formFieldsRecord
          ? extractPiiFromFields(formFieldsRecord)
          : { phone: null, email: null, firstName: null, lastName: null };
        unmatchedReason = computeUnmatchedReason({
          matchLevel: "unmatched",
          hasAnyClickId: !!(event.gclid || event.fbclid || event.wbraid || event.msclkid || event.ttclid || event.liFatId),
          hasPhoneSignal: !!piiFromStoredFields.phone || !!event.hashedPhone,
          hasEmailSignal: !!piiFromStoredFields.email || !!event.hashedEmail,
        });
      }
    }

    res.json({
      event: { ...event, fieldNames, unmatchedReason },
      matchedJob,
      matchedLead,
    });
  } catch (error) {
    console.error("[Attribution Event Detail] Error:", error);
    res.status(500).json({ error: "Failed to fetch event detail" });
  }
});

router.post("/attribution/reconcile", requireRole("super_admin", "agency_user"), async (req, res) => {
  try {
    const tenantId: number | null = req.body.tenantId ? Number(req.body.tenantId) : null;

    const result = await runReconciliation(tenantId, "manual");

    res.json({
      success: true,
      reconciled: result.jobsProcessed,
      breakdown: {
        diamond: result.diamond,
        golden: result.golden,
        silver: result.silver,
        bronze: result.bronze,
        unmatched: result.unmatched,
      },
      matchRate: result.matchRate,
      ociPayloadsGenerated: result.ociPayloads.length,
      enhancedConversionPayloads: result.enhancedConversionEligible,
      capiPayloads: result.capiEligible,
      message: `Reconciled ${result.jobsProcessed} jobs: ${result.diamond} diamond, ${result.golden} golden, ${result.silver} silver, ${result.bronze} bronze, ${result.unmatched} unmatched`,
    });
  } catch (error) {
    console.error("[Reconciliation] Error:", error);
    res.status(500).json({ error: "Reconciliation failed", details: error instanceof Error ? error.message : "Unknown error" });
  }
});

router.get("/attribution/reconciliation-status", async (req, res) => {
  try {
    const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
    const status = await getReconciliationStatus(tenantId);
    res.json(status);
  } catch (error) {
    console.error("[Reconciliation Status] Error:", error);
    res.status(500).json({ error: "Failed to get reconciliation status" });
  }
});

router.get("/attribution/oci-payloads", requireRole("super_admin", "agency_user"), async (req, res) => {
  try {
    const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
    const result = await runReconciliation(tenantId, "manual");
    res.json({
      payloads: result.ociPayloads,
      totalPayloads: result.ociPayloads.length,
      totalValue: result.ociPayloads.reduce((s, p) => s + p.conversionValue, 0),
    });
  } catch (error) {
    console.error("[OCI Payloads] Error:", error);
    res.status(500).json({ error: "Failed to generate OCI payloads" });
  }
});

export default router;
