import { Router, type IRouter } from "express";
import { db, attributionEventsTable, reconciliationRunsTable, jobsTable, leadsTable } from "@workspace/db";
import { eq, and, or, count, desc, sql, ilike, isNull, gte, inArray, SQL } from "drizzle-orm";
import { ListAttributionEventsQueryParams } from "@workspace/api-zod";
import { runReconciliation, getReconciliationStatus } from "../services/reconciliation";
import { requireRole, denyClientUser } from "../middleware/auth";
import { hashValue, hashPhone } from "../lib/phone-utils";
import { resolveListTenantScope, assertResourceTenantAccess, NO_TENANT_ASSIGNED_ERROR } from "../lib/tenant-scope";
import { extractFieldNamesForOperator, computeUnmatchedReason, extractPiiFromFields } from "./tracker";
import { revertManualMatchToUnmatched } from "../services/re-derive-lead-funnel";

const router: IRouter = Router();

router.use("/attribution", denyClientUser);

router.get("/attribution/events", async (req, res) => {
  const query = ListAttributionEventsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  const role = req.session.userRole;
  const userTenantId = req.session.tenantId;
  if (role !== "super_admin" && role !== "agency_user") {
    if (!userTenantId) {
      res.status(403).json(NO_TENANT_ASSIGNED_ERROR);
      return;
    }
    conditions.push(eq(attributionEventsTable.tenantId, userTenantId));
  } else if (query.tenantId) {
    conditions.push(eq(attributionEventsTable.tenantId, query.tenantId));
  }

  if (query.matchLevel) {
    const level = query.matchLevel as "diamond" | "golden" | "silver" | "bronze" | "manual" | "unmatched";
    conditions.push(eq(attributionEventsTable.matchLevel, level));
  }

  if (query.eventType) {
    conditions.push(eq(attributionEventsTable.eventType, query.eventType));
  }

  if (query.source) {
    // Frontend label is `resolvedLeadSource || utmSource`, so match either
    // the canonical resolved value or the raw utm_source when no resolved
    // value exists.
    const sourceCond = or(
      eq(attributionEventsTable.resolvedLeadSource, query.source),
      and(
        isNull(attributionEventsTable.resolvedLeadSource),
        eq(attributionEventsTable.utmSource, query.source),
      ),
    );
    if (sourceCond) conditions.push(sourceCond);
  }

  if (query.funnel) {
    // Sentinel value used by the Attribution page's funnel filter to
    // surface events that didn't resolve to any funnel (no _custom.funnel,
    // no field alias, no URL path alias, no subdomain rule). Task #575
    // removed the "first active funnel" default fallback, so unmatched
    // events now persist with `resolved_funnel = NULL` and need an
    // explicit option in the filter dropdown to be isolated.
    if (query.funnel === "__unmatched__") {
      conditions.push(isNull(attributionEventsTable.resolvedFunnel));
    } else {
      conditions.push(eq(attributionEventsTable.resolvedFunnel, query.funnel));
    }
  }

  if (query.dateRange) {
    const days = query.dateRange === "1d" ? 1 : query.dateRange === "7d" ? 7 : 30;
    conditions.push(
      gte(attributionEventsTable.createdAt, new Date(Date.now() - days * 86_400_000)),
    );
  }

  if (query.subdomainRule) {
    // Mirror extractSubdomain() from the frontend in SQL: take the URL's
    // hostname (lower-cased, www. and port stripped), and if it has at
    // least three labels return everything except the last two; otherwise
    // null.
    const hostnameExpr = sql`regexp_replace(regexp_replace(regexp_replace(lower(${attributionEventsTable.pageUrl}), '^https?://', ''), '(:[0-9]+)?/.*$', ''), '^www\\.', '')`;
    const partsExpr = sql`string_to_array(${hostnameExpr}, '.')`;
    const subdomainExpr = sql`(CASE WHEN array_length(${partsExpr}, 1) >= 3 THEN array_to_string(trim_array(${partsExpr}, 2), '.') ELSE NULL END)`;
    if (query.subdomainRule === "__none__") {
      conditions.push(
        sql`NOT EXISTS (SELECT 1 FROM subdomain_funnel_rules r WHERE r.tenant_id = ${attributionEventsTable.tenantId} AND r.subdomain = ${subdomainExpr})`,
      );
    } else {
      conditions.push(sql`${subdomainExpr} = ${query.subdomainRule}`);
    }
  }

  if (query.search) {
    const needle = `%${query.search}%`;
    const searchCond = or(
      ilike(attributionEventsTable.utmSource, needle),
      ilike(attributionEventsTable.utmCampaign, needle),
      ilike(attributionEventsTable.gclid, needle),
      ilike(attributionEventsTable.fbclid, needle),
      ilike(attributionEventsTable.pageUrl, needle),
      ilike(attributionEventsTable.landingPage, needle),
      ilike(attributionEventsTable.formName, needle),
      ilike(attributionEventsTable.resolvedLeadSource, needle),
      ilike(attributionEventsTable.resolvedFunnel, needle),
    );
    if (searchCond) conditions.push(searchCond);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const [events, [totalResult]] = await Promise.all([
    // Append the unique primary key as a deterministic tiebreaker so paging is
    // stable under LIMIT/OFFSET: createdAt ties leave rows the ORDER BY can't
    // distinguish, and Postgres gives no guaranteed order among them, so without
    // a unique secondary key adjacent pages can overlap or skip rows.
    db.select().from(attributionEventsTable).where(where).orderBy(desc(attributionEventsTable.createdAt), desc(attributionEventsTable.id)).limit(limit).offset(offset),
    db.select({ count: count() }).from(attributionEventsTable).where(where),
  ]);

  // Compute which of the events' created leads are now `sold` so the UI
  // can render a Sold badge and treat those rows as terminal. Using a
  // single roundtrip keyed by id keeps the list endpoint cheap.
  const createdLeadIds = Array.from(
    new Set(events.map(e => e.createdLeadId).filter((x): x is number => x != null)),
  );
  let soldLeadIds: number[] = [];
  if (createdLeadIds.length > 0) {
    const soldRows = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(
        inArray(leadsTable.id, createdLeadIds),
        eq(leadsTable.status, "sold"),
      ));
    soldLeadIds = soldRows.map(r => r.id);
  }

  res.json({ events, total: totalResult.count, soldLeadIds });
});

router.get("/attribution/events/facets", async (req, res) => {
  const conditions: SQL[] = [];

  const role = req.session.userRole;
  const userTenantId = req.session.tenantId;
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  if (role !== "super_admin" && role !== "agency_user") {
    if (!userTenantId) {
      res.status(403).json(NO_TENANT_ASSIGNED_ERROR);
      return;
    }
    conditions.push(eq(attributionEventsTable.tenantId, userTenantId));
  } else if (queryTenantId) {
    conditions.push(eq(attributionEventsTable.tenantId, queryTenantId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Distinct source values match the frontend label rule: prefer
  // resolved_lead_source, fall back to utm_source.
  const sourceExpr = sql<string>`COALESCE(${attributionEventsTable.resolvedLeadSource}, ${attributionEventsTable.utmSource})`;
  // Count of events that didn't resolve to any funnel — surfaced on the
  // Attribution page header so operators can see the unmatched bucket at a
  // glance and triage it via the existing funnel=`__unmatched__` filter
  // (task #577). The count honors the page's active dateRange filter so the
  // KPI reflects the same window operators are looking at; sources/funnels
  // intentionally stay unscoped so the dropdowns still show every value.
  const unmatchedConditions: SQL[] = [...conditions, isNull(attributionEventsTable.resolvedFunnel)];
  const rawDateRange = typeof req.query.dateRange === "string" ? req.query.dateRange : null;
  if (rawDateRange === "1d" || rawDateRange === "7d" || rawDateRange === "30d") {
    const days = rawDateRange === "1d" ? 1 : rawDateRange === "7d" ? 7 : 30;
    unmatchedConditions.push(
      gte(attributionEventsTable.createdAt, new Date(Date.now() - days * 86_400_000)),
    );
  }
  const unmatchedWhere = unmatchedConditions.length > 0 ? and(...unmatchedConditions) : undefined;

  const [sourceRows, funnelRows, unmatchedCountRow] = await Promise.all([
    db
      .selectDistinct({ value: sourceExpr })
      .from(attributionEventsTable)
      .where(where),
    db
      .selectDistinct({ value: attributionEventsTable.resolvedFunnel })
      .from(attributionEventsTable)
      .where(where),
    db
      .select({ count: count() })
      .from(attributionEventsTable)
      .where(unmatchedWhere),
  ]);

  const sources = sourceRows
    .map(r => r.value)
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .sort((a, b) => a.localeCompare(b));
  const funnels = funnelRows
    .map(r => r.value)
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .sort((a, b) => a.localeCompare(b));

  res.json({ sources, funnels, unmatchedCount: unmatchedCountRow[0]?.count ?? 0 });
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
        res.status(403).json(NO_TENANT_ASSIGNED_ERROR);
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
    let matchedLead: { id: number; firstName: string; lastName: string; funnelOverriddenAt: Date | null } | null = null;

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
            const [full] = await db.select({ funnelOverriddenAt: leadsTable.funnelOverriddenAt })
              .from(leadsTable).where(eq(leadsTable.id, lead.id)).limit(1);
            matchedLead = { id: lead.id, firstName: lead.firstName, lastName: lead.lastName, funnelOverriddenAt: full?.funnelOverriddenAt ?? null };
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
            const [full] = await db.select({ funnelOverriddenAt: leadsTable.funnelOverriddenAt })
              .from(leadsTable).where(eq(leadsTable.id, lead.id)).limit(1);
            matchedLead = { id: lead.id, firstName: lead.firstName, lastName: lead.lastName, funnelOverriddenAt: full?.funnelOverriddenAt ?? null };
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
        funnelOverriddenAt: leadsTable.funnelOverriddenAt,
      }).from(leadsTable).where(eq(leadsTable.id, matchedJob.leadId)).limit(1);
      if (lead) matchedLead = lead;
    }

    // Also surface matchedLead via createdLeadId (form_fill events have a
    // direct link to the lead they created — used by the attribution drawer
    // to show per-lead override status even when there's no matched job).
    if (!matchedLead && event.createdLeadId) {
      const [lead] = await db.select({
        id: leadsTable.id,
        firstName: leadsTable.firstName,
        lastName: leadsTable.lastName,
        funnelOverriddenAt: leadsTable.funnelOverriddenAt,
      }).from(leadsTable).where(eq(leadsTable.id, event.createdLeadId)).limit(1);
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

// Undo a manual match: flip an event from `matchLevel = "manual"` back to
// `"unmatched"` and re-emit the original "Why unmatched?" reason. Does NOT
// delete the underlying field-mapping rule or per-lead funnel override that
// produced the manual flip in the first place — clearing those is a separate
// operator action. Tenant-scoped via the same rules as the detail GET above.
router.post("/attribution/events/:id/revert-manual-match", async (req, res) => {
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
        res.status(403).json(NO_TENANT_ASSIGNED_ERROR);
        return;
      }
      conditions.push(eq(attributionEventsTable.tenantId, userTenantId));
    }

    const [event] = await db.select().from(attributionEventsTable).where(and(...conditions)).limit(1);
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    if (event.matchLevel !== "manual") {
      res.status(409).json({
        error: "Event is not currently manually matched",
        matchLevel: event.matchLevel,
      });
      return;
    }

    // Recompute the unmatched reason from the event's stored fields so the
    // "Why unmatched?" panel re-renders with an accurate diagnosis after the
    // revert. Mirrors the legacy fallback in the detail GET — same signal
    // sources, same wording.
    const formFieldsRecord = (event.formFields ?? null) as Record<string, unknown> | null;
    const piiFromStoredFields = formFieldsRecord
      ? extractPiiFromFields(formFieldsRecord)
      : { phone: null, email: null, firstName: null, lastName: null };
    const recomputedReason = computeUnmatchedReason({
      matchLevel: "unmatched",
      hasAnyClickId: !!(event.gclid || event.fbclid || event.wbraid || event.msclkid || event.ttclid || event.liFatId),
      hasPhoneSignal: !!piiFromStoredFields.phone || !!event.hashedPhone,
      hasEmailSignal: !!piiFromStoredFields.email || !!event.hashedEmail,
    });

    const flipped = await revertManualMatchToUnmatched(event.tenantId, event.id, recomputedReason);
    if (flipped === 0) {
      // Race: another writer flipped the row out from under us between the
      // read and the update. Re-read and surface the current state instead of
      // pretending the revert succeeded.
      const [fresh] = await db.select({ matchLevel: attributionEventsTable.matchLevel })
        .from(attributionEventsTable).where(eq(attributionEventsTable.id, event.id)).limit(1);
      res.status(409).json({
        error: "Event is not currently manually matched",
        matchLevel: fresh?.matchLevel ?? null,
      });
      return;
    }

    res.json({
      success: true,
      eventId: event.id,
      matchLevel: "unmatched" as const,
      unmatchedReason: recomputedReason,
    });
  } catch (error) {
    console.error("[Attribution Revert Manual Match] Error:", error);
    res.status(500).json({ error: "Failed to revert manual match" });
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
    const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
    const scope = resolveListTenantScope(req, res, queryTenantId);
    if (!scope.ok) return;
    const status = await getReconciliationStatus(scope.tenantId);
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
