import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db,
  subdomainFunnelRulesTable,
  funnelTypesTable,
  tenantFunnelTypesTable,
  attributionEventsTable,
  leadsTable,
} from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { invalidateSubdomainFunnelCache, extractSubdomain } from "../services/subdomain-funnel-resolver";
import { assertResourceTenantAccess } from "../lib/tenant-scope";

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

router.use("/subdomain-funnel-rules", requireManagerRole);

function normalizeSubdomain(raw: string): string {
  return raw.toLowerCase().trim().replace(/^www\./, "");
}

// Backfill: re-resolve historical attribution events whose page_url's
// subdomain matches `subdomain` and whose resolved_funnel is currently
// null/empty OR equals the tenant's default funnel (i.e. they fell through
// to the fallback). We deliberately leave events that already have a
// distinct resolved funnel alone — those came from explicit field/alias
// matches and shouldn't be overwritten by a coarser subdomain rule.
//
// Returns counts so the UI can show "Saved · Updated N past events".
async function backfillEventsForSubdomainRule(
  tenantId: number,
  subdomain: string,
  funnelTypeId: number,
  canonicalFunnelName: string,
): Promise<{ updatedEventCount: number; updatedLeadIds: number[] }> {
  const normSub = subdomain.toLowerCase().trim();
  if (!normSub) return { updatedEventCount: 0, updatedLeadIds: [] };

  // Identify default funnel name to know which "fell-through" rows to claim.
  const [defaultAssoc] = await db
    .select({ funnelName: funnelTypesTable.name })
    .from(tenantFunnelTypesTable)
    .innerJoin(funnelTypesTable, eq(tenantFunnelTypesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId))
    .orderBy(tenantFunnelTypesTable.funnelTypeId)
    .limit(1);
  const defaultFunnelName = defaultAssoc?.funnelName ?? null;

  // SQL subdomain extraction mirrors extractSubdomain():
  //  - lower(host), strip leading www.
  //  - require at least 3 dot-separated labels (else null)
  //  - subdomain = everything before the last 2 labels
  // Implemented as a CTE so we can index into the resulting array per row.
  const hostExpr = sql`regexp_replace(
    lower(substring(${attributionEventsTable.pageUrl} from '^https?://([^/?#]+)')),
    '^www\\.', ''
  )`;

  const candidates = await db.execute(sql`
    WITH parsed AS (
      SELECT
        ae.id,
        ae.created_lead_id,
        ae.resolved_funnel,
        string_to_array(${hostExpr}, '.') AS parts
      FROM attribution_events ae
      WHERE ae.tenant_id = ${tenantId}
        AND ae.page_url IS NOT NULL
    )
    SELECT id, created_lead_id, resolved_funnel
    FROM parsed
    WHERE array_length(parts, 1) >= 3
      AND array_to_string(parts[1:array_length(parts, 1) - 2], '.') = ${normSub}
  `);

  const rows = (candidates.rows ?? []) as Array<{
    id: number;
    created_lead_id: number | null;
    resolved_funnel: string | null;
  }>;

  const eligibleIds: number[] = [];
  const leadIdSet = new Set<number>();
  for (const r of rows) {
    const cur = (r.resolved_funnel ?? "").trim();
    const isFellThrough =
      !cur ||
      (defaultFunnelName !== null && cur.toLowerCase() === defaultFunnelName.toLowerCase());
    if (!isFellThrough) continue;
    if (cur.toLowerCase() === canonicalFunnelName.toLowerCase()) continue;
    eligibleIds.push(r.id);
    if (r.created_lead_id) leadIdSet.add(r.created_lead_id);
  }

  if (eligibleIds.length > 0) {
    await db
      .update(attributionEventsTable)
      .set({ resolvedFunnel: canonicalFunnelName })
      .where(and(
        eq(attributionEventsTable.tenantId, tenantId),
        inArray(attributionEventsTable.id, eligibleIds),
      ));
  }

  // Propagate to denormalized lead.lead_type / funnel_id for leads created by
  // these events whose current funnel still reflects the fall-through value
  // (null/empty/default). Don't clobber leads that already have a distinct
  // funnel from another correction path.
  const updatedLeadIds: number[] = [];
  if (leadIdSet.size > 0) {
    const leadIds = Array.from(leadIdSet);
    const leads = await db
      .select({ id: leadsTable.id, leadType: leadsTable.leadType, funnelId: leadsTable.funnelId })
      .from(leadsTable)
      .where(and(
        eq(leadsTable.tenantId, tenantId),
        inArray(leadsTable.id, leadIds),
      ));
    const toUpdate: number[] = [];
    for (const l of leads) {
      const cur = (l.leadType ?? "").trim();
      const isFellThrough =
        !cur ||
        (defaultFunnelName !== null && cur.toLowerCase() === defaultFunnelName.toLowerCase());
      if (!isFellThrough && cur.toLowerCase() !== canonicalFunnelName.toLowerCase()) continue;
      if (cur === canonicalFunnelName && l.funnelId === funnelTypeId) continue;
      toUpdate.push(l.id);
    }
    if (toUpdate.length > 0) {
      await db
        .update(leadsTable)
        .set({ leadType: canonicalFunnelName, funnelId: funnelTypeId, updatedAt: new Date() })
        .where(and(
          eq(leadsTable.tenantId, tenantId),
          inArray(leadsTable.id, toUpdate),
        ));
      updatedLeadIds.push(...toUpdate);
    }
  }

  return { updatedEventCount: eligibleIds.length, updatedLeadIds };
}

router.get("/subdomain-funnel-rules", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ rules: [] });
    return;
  }

  const rows = await db
    .select({
      id: subdomainFunnelRulesTable.id,
      subdomain: subdomainFunnelRulesTable.subdomain,
      funnelTypeId: subdomainFunnelRulesTable.funnelTypeId,
      funnelName: funnelTypesTable.name,
      createdAt: subdomainFunnelRulesTable.createdAt,
    })
    .from(subdomainFunnelRulesTable)
    .innerJoin(funnelTypesTable, eq(subdomainFunnelRulesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(subdomainFunnelRulesTable.tenantId, tenantId))
    .orderBy(subdomainFunnelRulesTable.subdomain);

  res.json({ rules: rows });
});

router.post("/subdomain-funnel-rules", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const { subdomain, funnelTypeId } = req.body as {
    subdomain?: string;
    funnelTypeId?: number | string;
  };
  if (!subdomain || typeof subdomain !== "string" || !funnelTypeId) {
    res.status(400).json({ error: "subdomain and funnelTypeId are required" });
    return;
  }

  const normSub = normalizeSubdomain(subdomain);
  if (!normSub) {
    res.status(400).json({ error: "subdomain cannot be empty" });
    return;
  }

  const numericFunnelTypeId = Number(funnelTypeId);
  const [tenantAssoc] = await db
    .select({ id: tenantFunnelTypesTable.funnelTypeId })
    .from(tenantFunnelTypesTable)
    .where(and(
      eq(tenantFunnelTypesTable.tenantId, tenantId),
      eq(tenantFunnelTypesTable.funnelTypeId, numericFunnelTypeId),
    ));
  if (!tenantAssoc) {
    res.status(400).json({ error: "Funnel type is not enabled for this tenant" });
    return;
  }

  const [funnelType] = await db
    .select({ id: funnelTypesTable.id, name: funnelTypesTable.name })
    .from(funnelTypesTable)
    .where(eq(funnelTypesTable.id, numericFunnelTypeId));
  if (!funnelType) {
    res.status(400).json({ error: "Unknown funnel type" });
    return;
  }

  const existing = await db
    .select()
    .from(subdomainFunnelRulesTable)
    .where(and(
      eq(subdomainFunnelRulesTable.tenantId, tenantId),
      eq(subdomainFunnelRulesTable.subdomain, normSub),
    ));

  let ruleId: number;
  let created: boolean;
  if (existing.length > 0) {
    if (existing[0].funnelTypeId === numericFunnelTypeId) {
      ruleId = existing[0].id;
      created = false;
    } else {
      const [updated] = await db
        .update(subdomainFunnelRulesTable)
        .set({ funnelTypeId: numericFunnelTypeId })
        .where(eq(subdomainFunnelRulesTable.id, existing[0].id))
        .returning();
      ruleId = updated.id;
      created = false;
    }
  } else {
    const [inserted] = await db
      .insert(subdomainFunnelRulesTable)
      .values({ tenantId, funnelTypeId: numericFunnelTypeId, subdomain: normSub })
      .returning();
    ruleId = inserted.id;
    created = true;
  }

  invalidateSubdomainFunnelCache(tenantId);

  const { updatedEventCount, updatedLeadIds } = await backfillEventsForSubdomainRule(
    tenantId,
    normSub,
    numericFunnelTypeId,
    funnelType.name,
  );

  res.json({
    rule: {
      id: ruleId,
      tenantId,
      subdomain: normSub,
      funnelTypeId: numericFunnelTypeId,
      funnelName: funnelType.name,
    },
    created,
    updatedEventCount,
    updatedLeadCount: updatedLeadIds.length,
  });
});

router.delete("/subdomain-funnel-rules/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(subdomainFunnelRulesTable)
    .where(eq(subdomainFunnelRulesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  const access = assertResourceTenantAccess(req, res, existing.tenantId, {
    notFoundOnMismatch: true,
    notFoundMessage: "Rule not found",
  });
  if (!access.ok) return;

  await db.delete(subdomainFunnelRulesTable).where(eq(subdomainFunnelRulesTable.id, id));
  invalidateSubdomainFunnelCache(existing.tenantId);
  res.json({ success: true });
});

export { extractSubdomain };
export default router;
