import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, fieldMappingRulesTable, attributionEventsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { invalidateRuleCache } from "../services/field-detection";
import { assertResourceTenantAccess } from "../lib/tenant-scope";
import { reDeriveLeadFunnel } from "../services/re-derive-lead-funnel";
import { enqueueReDeriveLeadsForRuleScope } from "../services/re-derive-jobs";
import { emitRuleRederiveFailed } from "../socket";
import { countPendingRederiveLeadsForRuleScope } from "../services/re-derive-lead-funnel";

const router: IRouter = Router();

function requireManagerRole(req: Request, res: Response, next: NextFunction) {
  const role = req.session.userRole;
  if (!role || !["super_admin", "agency_user", "client_admin"].includes(role)) {
    res.status(403).json({ error: "Access denied. Requires manager role." });
    return;
  }
  next();
}

function resolveTenantId(req: Request): number | null {
  const session = req.session;
  const role = session.userRole;
  if (role === "super_admin" || role === "agency_user") {
    return req.query.tenantId ? Number(req.query.tenantId) : session.tenantId ?? null;
  }
  return session.tenantId ?? null;
}

router.use("/field-mapping-rules", requireManagerRole);

const VALID_MAPS_TO = [
  "firstName", "lastName", "fullName", "email", "phone",
  "address", "city", "state", "zip",
  "funnel", "appointmentDate", "appointmentTime",
] as const;
const VALID_MAPS_TO_SET: ReadonlySet<string> = new Set(VALID_MAPS_TO);

function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[\s\-\.]/g, "_");
}

router.get("/field-mapping-rules/suggestions", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ suggestions: {} });
    return;
  }

  const rows = await db.select().from(fieldMappingRulesTable)
    .where(eq(fieldMappingRulesTable.tenantId, tenantId));

  // Aggregate per normalized field name: pick the most-frequently-used mapsTo,
  // tie-broken by the most recently created rule. Skip targets that aren't
  // valid (defensive against legacy/garbage rows).
  type Tally = { counts: Map<string, number>; latestAt: Map<string, number> };
  const byField = new Map<string, Tally>();

  for (const row of rows) {
    if (!VALID_MAPS_TO_SET.has(row.mapsTo)) continue;
    const key = normalizeFieldKey(row.fieldName);
    if (!key) continue;
    let tally = byField.get(key);
    if (!tally) {
      tally = { counts: new Map(), latestAt: new Map() };
      byField.set(key, tally);
    }
    tally.counts.set(row.mapsTo, (tally.counts.get(row.mapsTo) ?? 0) + 1);
    const at = row.createdAt instanceof Date ? row.createdAt.getTime() : 0;
    const prev = tally.latestAt.get(row.mapsTo) ?? 0;
    if (at > prev) tally.latestAt.set(row.mapsTo, at);
  }

  const suggestions: Record<string, string> = {};
  for (const [fieldName, tally] of byField.entries()) {
    let bestTarget: string | null = null;
    let bestCount = -1;
    let bestLatest = -1;
    for (const [target, count] of tally.counts.entries()) {
      const latest = tally.latestAt.get(target) ?? 0;
      if (count > bestCount || (count === bestCount && latest > bestLatest)) {
        bestTarget = target;
        bestCount = count;
        bestLatest = latest;
      }
    }
    if (bestTarget) suggestions[fieldName] = bestTarget;
  }

  res.json({ suggestions });
});

router.get("/field-mapping-rules", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ rules: [] });
    return;
  }

  const pageUrlPattern = req.query.pageUrlPattern as string | undefined;
  const formIdentifier = req.query.formIdentifier as string | undefined;

  let conditions = [eq(fieldMappingRulesTable.tenantId, tenantId)];
  if (pageUrlPattern) conditions.push(eq(fieldMappingRulesTable.pageUrlPattern, pageUrlPattern));
  if (formIdentifier) conditions.push(eq(fieldMappingRulesTable.formIdentifier, formIdentifier));

  const rows = await db.select().from(fieldMappingRulesTable)
    .where(and(...conditions))
    .orderBy(fieldMappingRulesTable.pageUrlPattern, fieldMappingRulesTable.formIdentifier, fieldMappingRulesTable.priority);

  res.json({ rules: rows });
});

router.post("/field-mapping-rules", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const { pageUrlPattern, formIdentifier, fieldName, mapsTo, priority, attributionEventId, leadId } = req.body;
  if (!pageUrlPattern || !formIdentifier || !fieldName || !mapsTo) {
    res.status(400).json({ error: "pageUrlPattern, formIdentifier, fieldName, and mapsTo are required" });
    return;
  }

  if (!VALID_MAPS_TO_SET.has(mapsTo)) {
    res.status(400).json({ error: `mapsTo must be one of: ${VALID_MAPS_TO.join(", ")}` });
    return;
  }

  const existing = await db.select().from(fieldMappingRulesTable)
    .where(and(
      eq(fieldMappingRulesTable.tenantId, tenantId),
      eq(fieldMappingRulesTable.pageUrlPattern, pageUrlPattern),
      eq(fieldMappingRulesTable.formIdentifier, formIdentifier),
      eq(fieldMappingRulesTable.fieldName, fieldName),
    ));

  let resultRule;
  let wasUpdate = false;
  if (existing.length > 0) {
    const [updated] = await db.update(fieldMappingRulesTable)
      .set({ mapsTo, priority: priority ?? 0, updatedAt: new Date() })
      .where(eq(fieldMappingRulesTable.id, existing[0].id))
      .returning();
    resultRule = updated;
    wasUpdate = true;
  } else {
    const [row] = await db.insert(fieldMappingRulesTable).values({
      tenantId,
      pageUrlPattern,
      formIdentifier,
      fieldName,
      mapsTo,
      priority: priority ?? 0,
    }).returning();
    resultRule = row;
  }

  invalidateRuleCache(tenantId, pageUrlPattern);

  // When the operator edits a mapping from a lead/event context, immediately
  // re-run field detection + funnel normalization for that lead so the open
  // Pulse drawer reflects the new funnel without waiting for the next ingest.
  let leadFunnelChanged = false;
  let resolvedLeadId: number | null = null;
  if (typeof leadId === "number" && Number.isFinite(leadId)) {
    resolvedLeadId = leadId;
  } else if (typeof attributionEventId === "number" && Number.isFinite(attributionEventId)) {
    const [ev] = await db.select({ createdLeadId: attributionEventsTable.createdLeadId, tenantId: attributionEventsTable.tenantId })
      .from(attributionEventsTable)
      .where(eq(attributionEventsTable.id, attributionEventId));
    if (ev && ev.tenantId === tenantId && ev.createdLeadId) resolvedLeadId = ev.createdLeadId;
  }
  if (resolvedLeadId) {
    try {
      const rederive = await reDeriveLeadFunnel(tenantId, resolvedLeadId);
      if (rederive?.changed) leadFunnelChanged = true;
    } catch (err) {
      console.error("[field-mapping-rules.POST] reDeriveLeadFunnel failed:", err);
    }
  }

  // scope so older form submissions also pick up this mapping. We enqueue
  // this as a durable background job so the save stays snappy and the work
  // survives restarts, gets retried on failure, and is observable via the
  // `background_jobs` table. The job handler emits `rule-rederive-complete`
  // on the tenant socket room when it finishes so the operator's panel can
  // clear its "working…" state.
  try {
    await enqueueReDeriveLeadsForRuleScope({
      tenantId,
      pageUrlPattern: pageUrlPattern as string,
      formIdentifier: formIdentifier as string,
      excludeLeadId: resolvedLeadId,
    });
  } catch (err) {
    console.error("[field-mapping-rules.POST] failed to enqueue rederive job:", err);
    // Surface the enqueue failure to the operator's UI so they aren't left
    // staring at a "working…" indicator forever — the panel will replace it
    // with a "couldn't re-derive historical leads" hint and a retry button.
    // Best-effort pending-lead count so the panel can show
    // "~N historical leads still need updating" next to the retry button.
    let pendingCount: Awaited<ReturnType<typeof countPendingRederiveLeadsForRuleScope>> | null = null;
    try {
      pendingCount = await countPendingRederiveLeadsForRuleScope(
        tenantId,
        pageUrlPattern as string,
        formIdentifier as string,
        { excludeLeadId: resolvedLeadId },
      );
    } catch (countErr) {
      console.error("[field-mapping-rules.POST] countPendingRederiveLeadsForRuleScope failed:", countErr);
    }
    try {
      emitRuleRederiveFailed(tenantId, {
        pageUrlPattern: pageUrlPattern as string,
        formIdentifier: formIdentifier as string,
        reason: err instanceof Error ? err.message : String(err),
        pendingLeads: pendingCount?.pendingLeads,
        hitLimit: pendingCount?.hitLimit,
        maxLeads: pendingCount?.maxLeads,
        lastAttemptedAt: pendingCount?.lastAttemptedAt ?? new Date().toISOString(),
      });
    } catch (emitErr) {
      console.error("[field-mapping-rules.POST] emitRuleRederiveFailed failed:", emitErr);
    }
  }

  res.json({ rule: resultRule, updated: wasUpdate, leadFunnelChanged });
});

router.delete("/field-mapping-rules/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db.select().from(fieldMappingRulesTable)
    .where(eq(fieldMappingRulesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Rule not found" }); return; }

  const access = assertResourceTenantAccess(req, res, existing.tenantId, {
    notFoundOnMismatch: true, notFoundMessage: "Rule not found",
  });
  if (!access.ok) return;

  await db.delete(fieldMappingRulesTable)
    .where(eq(fieldMappingRulesTable.id, id));

  invalidateRuleCache(existing.tenantId, existing.pageUrlPattern);
  res.json({ success: true });
});

export default router;
