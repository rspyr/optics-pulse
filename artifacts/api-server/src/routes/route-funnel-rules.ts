import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db,
  routeFunnelRulesTable,
  routeSuggestionDismissalsTable,
  funnelTypesTable,
  tenantFunnelTypesTable,
  attributionEventsTable,
  leadsTable,
  funnelAliasesTable,
} from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { invalidateRouteFunnelCache, normalizeRoutePath } from "../services/route-funnel-resolver";
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

router.use("/route-funnel-rules", requireManagerRole);

// SQL expression that extracts and normalizes the pathname from
// attribution_events.page_url, mirroring normalizeRoutePath() in JS:
//   - capture the path portion after the authority, before ?/# 
//   - lowercase
//   - collapse a trailing slash (except the root "/")
//   - empty path → "/"
// Requires the source table to be aliased `ae` in the surrounding query.
const ROUTE_PATH_EXPR = sql`CASE
  WHEN lower(coalesce(substring(ae.page_url from '^https?://[^/?#]+([^?#]*)'), '')) IN ('', '/') THEN '/'
  ELSE regexp_replace(lower(coalesce(substring(ae.page_url from '^https?://[^/?#]+([^?#]*)'), '')), '/+$', '')
END`;

// Backfill: re-resolve historical attribution events whose page_url's
// normalized pathname matches `routePath` and whose resolved_funnel is
// currently null/empty OR equals the tenant's default funnel (fell through to
// the fallback). Events that already carry a distinct resolved funnel from an
// explicit field/alias/subdomain match are left alone unless forceOverride.
//
// Returns counts so the UI can show "Saved · Updated N past events".
type PriorEventValue = { id: number; resolvedFunnel: string | null };
type PriorLeadValue = { id: number; leadType: string | null; funnelId: number | null };

// Given a list of (possibly null/duplicate) candidate lead ids, return the
// subset whose `funnel_overridden_at` is set, so a coarser route rule can
// never overwrite a per-lead override.
async function loadOverriddenLeadIds(
  tenantId: number,
  candidateLeadIds: Array<number | null>,
): Promise<Set<number>> {
  const ids = Array.from(
    new Set(candidateLeadIds.filter((x): x is number => typeof x === "number")),
  );
  if (ids.length === 0) return new Set<number>();
  const rows = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(and(
      eq(leadsTable.tenantId, tenantId),
      inArray(leadsTable.id, ids),
      sql`${leadsTable.funnelOverriddenAt} IS NOT NULL`,
    ));
  return new Set(rows.map((r) => r.id));
}

async function backfillEventsForRouteRule(
  tenantId: number,
  routePath: string,
  funnelTypeId: number,
  canonicalFunnelName: string,
  priorFunnelName: string | null = null,
  options: { dryRun?: boolean; forceOverride?: boolean } = {},
): Promise<{
  updatedEventCount: number;
  updatedLeadIds: number[];
  eligibleEventIds: number[];
  priorEventValues: PriorEventValue[];
  priorLeadValues: PriorLeadValue[];
}> {
  const dryRun = options.dryRun === true;
  const forceOverride = options.forceOverride === true;
  const normPath = normalizeRoutePath(routePath);
  if (!normPath) return { updatedEventCount: 0, updatedLeadIds: [], eligibleEventIds: [], priorEventValues: [], priorLeadValues: [] };
  const priorLc = priorFunnelName?.toLowerCase() ?? null;

  const [defaultAssoc] = await db
    .select({ funnelName: funnelTypesTable.name })
    .from(tenantFunnelTypesTable)
    .innerJoin(funnelTypesTable, eq(tenantFunnelTypesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId))
    .orderBy(tenantFunnelTypesTable.funnelTypeId)
    .limit(1);
  const defaultFunnelName = defaultAssoc?.funnelName ?? null;

  const candidates = await db.execute(sql`
    WITH parsed AS (
      SELECT
        ae.id,
        ae.created_lead_id,
        ae.resolved_funnel,
        ${ROUTE_PATH_EXPR} AS route_path
      FROM attribution_events ae
      WHERE ae.tenant_id = ${tenantId}
        AND ae.page_url IS NOT NULL
    )
    SELECT id, created_lead_id, resolved_funnel
    FROM parsed
    WHERE route_path = ${normPath}
  `);

  const rows = (candidates.rows ?? []) as Array<{
    id: number;
    created_lead_id: number | null;
    resolved_funnel: string | null;
  }>;

  // Never let a (coarser) route rule clobber a lead an operator has explicitly
  // pinned with a per-lead funnel override. We exclude both the overridden
  // lead's row AND that lead's attribution events so the manual correction
  // survives route-rule create / re-point / accept-suggestion / force-override.
  const overriddenLeadIds = await loadOverriddenLeadIds(
    tenantId,
    rows.map((r) => r.created_lead_id),
  );

  const eligibleIds: number[] = [];
  const priorEventValues: PriorEventValue[] = [];
  const leadIdSet = new Set<number>();
  const newLc = canonicalFunnelName.toLowerCase();
  for (const r of rows) {
    if (r.created_lead_id && overriddenLeadIds.has(r.created_lead_id)) continue;
    const cur = (r.resolved_funnel ?? "").trim();
    const curLc = cur.toLowerCase();
    const isFellThrough =
      !cur ||
      (defaultFunnelName !== null && curLc === defaultFunnelName.toLowerCase());
    const isPriorRuleMatch = priorLc !== null && priorLc !== newLc && curLc === priorLc;
    if (curLc === newLc) continue;
    if (!isFellThrough && !isPriorRuleMatch && !forceOverride) continue;
    eligibleIds.push(r.id);
    priorEventValues.push({ id: r.id, resolvedFunnel: r.resolved_funnel });
    if (r.created_lead_id) leadIdSet.add(r.created_lead_id);
  }

  if (eligibleIds.length > 0 && !dryRun) {
    await db
      .update(attributionEventsTable)
      .set({ resolvedFunnel: canonicalFunnelName })
      .where(and(
        eq(attributionEventsTable.tenantId, tenantId),
        inArray(attributionEventsTable.id, eligibleIds),
      ));
  }

  const updatedLeadIds: number[] = [];
  const priorLeadValues: PriorLeadValue[] = [];
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
      const curLc = cur.toLowerCase();
      const isFellThrough =
        !cur ||
        (defaultFunnelName !== null && curLc === defaultFunnelName.toLowerCase());
      const isPriorRuleMatch = priorLc !== null && priorLc !== newLc && curLc === priorLc;
      const isCanonical = curLc === newLc;
      if (isCanonical && l.funnelId === funnelTypeId) continue;
      if (!isFellThrough && !isPriorRuleMatch && !isCanonical && !forceOverride) continue;
      toUpdate.push(l.id);
      priorLeadValues.push({ id: l.id, leadType: l.leadType ?? null, funnelId: l.funnelId ?? null });
    }
    if (toUpdate.length > 0) {
      if (!dryRun) {
        await db
          .update(leadsTable)
          .set({ leadType: canonicalFunnelName, funnelId: funnelTypeId, updatedAt: new Date() })
          .where(and(
            eq(leadsTable.tenantId, tenantId),
            inArray(leadsTable.id, toUpdate),
          ));
      }
      updatedLeadIds.push(...toUpdate);
    }
  }

  return {
    updatedEventCount: eligibleIds.length,
    updatedLeadIds,
    eligibleEventIds: eligibleIds,
    priorEventValues,
    priorLeadValues,
  };
}

// In-memory undo batches for force-override saves (see subdomain rules for the
// rationale). Restarts drop these; operators only ever see a fresh banner.
type UndoBatch = {
  tenantId: number;
  routePath: string;
  createdAt: number;
  events: PriorEventValue[];
  leads: PriorLeadValue[];
};
const undoBatches = new Map<string, UndoBatch>();
const UNDO_WINDOW_MS = 30 * 1000;
const UNDO_GRACE_MS = 5 * 1000;
const UNDO_TTL_MS = UNDO_WINDOW_MS + UNDO_GRACE_MS;

function pruneUndoBatches() {
  const now = Date.now();
  for (const [k, v] of undoBatches.entries()) {
    if (now - v.createdAt > UNDO_TTL_MS) undoBatches.delete(k);
  }
}

// Suggest route → funnel rules from historical attribution events, mirroring
// the subdomain suggestion heuristic but keyed on the normalized pathname.
router.get("/route-funnel-rules/suggestions", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ suggestions: [], hiddenRoutePaths: [] });
    return;
  }
  const userId = req.session.userId ?? null;

  const [defaultAssoc] = await db
    .select({ funnelName: funnelTypesTable.name })
    .from(tenantFunnelTypesTable)
    .innerJoin(funnelTypesTable, eq(tenantFunnelTypesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId))
    .orderBy(tenantFunnelTypesTable.funnelTypeId)
    .limit(1);
  const defaultFunnelLcName = defaultAssoc?.funnelName?.toLowerCase() ?? null;

  const tenantFunnels = await db
    .select({ id: funnelTypesTable.id, name: funnelTypesTable.name })
    .from(tenantFunnelTypesTable)
    .innerJoin(funnelTypesTable, eq(tenantFunnelTypesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId));
  const funnelByLcName = new Map(tenantFunnels.map(f => [f.name.toLowerCase(), f]));

  const aliasRows = await db
    .select({ alias: funnelAliasesTable.alias, funnelTypeId: funnelAliasesTable.funnelTypeId })
    .from(funnelAliasesTable)
    .where(eq(funnelAliasesTable.tenantId, tenantId));
  const aliasesByFunnelId = new Map<number, string[]>();
  for (const a of aliasRows) {
    const arr = aliasesByFunnelId.get(a.funnelTypeId) ?? [];
    arr.push(a.alias);
    aliasesByFunnelId.set(a.funnelTypeId, arr);
  }

  const existingRules = await db
    .select({ routePath: routeFunnelRulesTable.routePath })
    .from(routeFunnelRulesTable)
    .where(eq(routeFunnelRulesTable.tenantId, tenantId));
  const ruled = new Set(existingRules.map(r => r.routePath.toLowerCase()));

  const dismissedRows = userId
    ? await db
        .select({ routePath: routeSuggestionDismissalsTable.routePath })
        .from(routeSuggestionDismissalsTable)
        .where(and(
          eq(routeSuggestionDismissalsTable.tenantId, tenantId),
          eq(routeSuggestionDismissalsTable.userId, userId),
        ))
    : [];
  const dismissed = new Set(dismissedRows.map(r => r.routePath.toLowerCase()));

  const grouped = await db.execute(sql`
    WITH parsed AS (
      SELECT
        ae.resolved_funnel,
        ${ROUTE_PATH_EXPR} AS route_path
      FROM attribution_events ae
      WHERE ae.tenant_id = ${tenantId}
        AND ae.page_url IS NOT NULL
        AND ae.created_at > now() - interval '90 days'
    )
    SELECT
      route_path,
      resolved_funnel,
      count(*)::int AS cnt
    FROM parsed
    GROUP BY route_path, resolved_funnel
  `);

  type Row = { route_path: string; resolved_funnel: string | null; cnt: number };
  const rows = (grouped.rows ?? []) as Row[];

  const byPath = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.route_path) continue;
    // The bare root "/" is too generic to ever be a useful funnel rule.
    if (r.route_path === "/") continue;
    if (ruled.has(r.route_path)) continue;
    const arr = byPath.get(r.route_path) ?? [];
    arr.push(r);
    byPath.set(r.route_path, arr);
  }

  const suggestions: Array<{
    routePath: string;
    suggestedFunnelTypeId: number;
    suggestedFunnelName: string;
    eventCount: number;
    fellThroughCount: number;
    reason: "observed" | "label-match";
    matchedAlias?: string;
  }> = [];

  const tokenize = (s: string): string[] =>
    s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  const heuristicFunnels = tenantFunnels
    .filter((f) => f.name.toLowerCase() !== defaultFunnelLcName)
    .map((f) => {
      const aliases = aliasesByFunnelId.get(f.id) ?? [];
      const nameTokens = tokenize(f.name);
      const aliasTokenMap = new Map<string, string>();
      for (const alias of aliases) {
        for (const t of tokenize(alias)) {
          if (!aliasTokenMap.has(t)) aliasTokenMap.set(t, alias);
        }
      }
      return {
        ...f,
        tokens: new Set(nameTokens),
        aliases,
        aliasTokenMap,
      };
    });

  for (const [routePath, srows] of byPath.entries()) {
    const distinctFunnels = new Map<string, number>();
    let fellThrough = 0;
    let total = 0;
    for (const r of srows) {
      total += r.cnt;
      const cur = (r.resolved_funnel ?? "").trim();
      const isFellThrough =
        !cur || (defaultFunnelLcName !== null && cur.toLowerCase() === defaultFunnelLcName);
      if (isFellThrough) {
        fellThrough += r.cnt;
      } else {
        const lc = cur.toLowerCase();
        distinctFunnels.set(lc, (distinctFunnels.get(lc) ?? 0) + r.cnt);
      }
    }
    if (total < 3) continue;

    if (distinctFunnels.size === 1) {
      const [funnelLcName] = [...distinctFunnels.keys()];
      const funnel = funnelByLcName.get(funnelLcName);
      if (!funnel) continue;
      suggestions.push({
        routePath,
        suggestedFunnelTypeId: funnel.id,
        suggestedFunnelName: funnel.name,
        eventCount: total,
        fellThroughCount: fellThrough,
        reason: "observed",
      });
      continue;
    }

    if (distinctFunnels.size === 0 && fellThrough >= 3 && heuristicFunnels.length > 0) {
      const subTokens = tokenize(routePath);
      if (subTokens.length === 0) continue;
      const subLc = routePath.toLowerCase();
      type MatchInfo = { funnel: (typeof heuristicFunnels)[number]; matchedAlias?: string };
      const matches: MatchInfo[] = [];
      for (const f of heuristicFunnels) {
        let nameMatched = false;
        for (const t of subTokens) {
          if (f.tokens.has(t)) { nameMatched = true; break; }
        }
        if (!nameMatched) {
          const fnameLc = f.name.toLowerCase();
          for (const t of subTokens) {
            if (t.length >= 4 && fnameLc.includes(t)) { nameMatched = true; break; }
          }
        }
        if (!nameMatched) {
          for (const t of f.tokens) {
            if (t.length >= 4 && subLc.includes(t)) { nameMatched = true; break; }
          }
        }
        if (nameMatched) {
          matches.push({ funnel: f });
          continue;
        }
        let aliasMatch: string | undefined;
        for (const t of subTokens) {
          const a = f.aliasTokenMap.get(t);
          if (a) { aliasMatch = a; break; }
        }
        if (!aliasMatch) {
          for (const alias of f.aliases) {
            const aliasLc = alias.toLowerCase();
            for (const t of subTokens) {
              if (t.length >= 4 && aliasLc.includes(t)) { aliasMatch = alias; break; }
            }
            if (aliasMatch) break;
            for (const t of tokenize(alias)) {
              if (t.length >= 4 && subLc.includes(t)) { aliasMatch = alias; break; }
            }
            if (aliasMatch) break;
          }
        }
        if (aliasMatch) {
          matches.push({ funnel: f, matchedAlias: aliasMatch });
        }
      }
      if (matches.length !== 1) continue;
      const { funnel, matchedAlias } = matches[0];
      suggestions.push({
        routePath,
        suggestedFunnelTypeId: funnel.id,
        suggestedFunnelName: funnel.name,
        eventCount: total,
        fellThroughCount: fellThrough,
        reason: "label-match",
        ...(matchedAlias ? { matchedAlias } : {}),
      });
    }
  }

  suggestions.sort((a, b) => b.eventCount - a.eventCount);

  const visible = suggestions.filter(s => !dismissed.has(s.routePath.toLowerCase()));
  const hiddenRoutePaths = suggestions
    .filter(s => dismissed.has(s.routePath.toLowerCase()))
    .map(s => s.routePath);

  res.json({ suggestions: visible, hiddenRoutePaths });
});

router.post("/route-funnel-rules/suggestions/dismiss", async (req, res) => {
  const tenantId = resolveTenantId(req);
  const userId = req.session.userId ?? null;
  if (!tenantId || !userId) {
    res.status(400).json({ error: "No tenant or user context" });
    return;
  }
  const { routePath } = req.body as { routePath?: string };
  if (!routePath || typeof routePath !== "string") {
    res.status(400).json({ error: "routePath is required" });
    return;
  }
  const normPath = normalizeRoutePath(routePath);
  if (!normPath) {
    res.status(400).json({ error: "routePath cannot be empty" });
    return;
  }

  await db
    .insert(routeSuggestionDismissalsTable)
    .values({ tenantId, userId, routePath: normPath })
    .onConflictDoNothing({
      target: [
        routeSuggestionDismissalsTable.tenantId,
        routeSuggestionDismissalsTable.userId,
        routeSuggestionDismissalsTable.routePath,
      ],
    });

  res.json({ success: true });
});

router.post("/route-funnel-rules/suggestions/undo-dismiss", async (req, res) => {
  const tenantId = resolveTenantId(req);
  const userId = req.session.userId ?? null;
  if (!tenantId || !userId) {
    res.status(400).json({ error: "No tenant or user context" });
    return;
  }
  const { routePath } = (req.body ?? {}) as { routePath?: string };

  if (routePath && typeof routePath === "string") {
    const normPath = normalizeRoutePath(routePath);
    await db
      .delete(routeSuggestionDismissalsTable)
      .where(and(
        eq(routeSuggestionDismissalsTable.tenantId, tenantId),
        eq(routeSuggestionDismissalsTable.userId, userId),
        eq(routeSuggestionDismissalsTable.routePath, normPath ?? routePath),
      ));
  } else {
    await db
      .delete(routeSuggestionDismissalsTable)
      .where(and(
        eq(routeSuggestionDismissalsTable.tenantId, tenantId),
        eq(routeSuggestionDismissalsTable.userId, userId),
      ));
  }

  res.json({ success: true });
});

router.get("/route-funnel-rules", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ rules: [] });
    return;
  }

  const rows = await db
    .select({
      id: routeFunnelRulesTable.id,
      routePath: routeFunnelRulesTable.routePath,
      funnelTypeId: routeFunnelRulesTable.funnelTypeId,
      funnelName: funnelTypesTable.name,
      createdAt: routeFunnelRulesTable.createdAt,
    })
    .from(routeFunnelRulesTable)
    .innerJoin(funnelTypesTable, eq(routeFunnelRulesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(routeFunnelRulesTable.tenantId, tenantId))
    .orderBy(routeFunnelRulesTable.routePath);

  res.json({ rules: rows });
});

router.post("/route-funnel-rules/preview", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const { routePath, funnelTypeId, forceOverride } = req.body as {
    routePath?: string;
    funnelTypeId?: number | string;
    forceOverride?: boolean;
  };
  if (!routePath || typeof routePath !== "string" || !funnelTypeId) {
    res.status(400).json({ error: "routePath and funnelTypeId are required" });
    return;
  }

  const normPath = normalizeRoutePath(routePath);
  if (!normPath) {
    res.status(400).json({ error: "routePath cannot be empty" });
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

  const [defaultAssoc] = await db
    .select({ funnelName: funnelTypesTable.name })
    .from(tenantFunnelTypesTable)
    .innerJoin(funnelTypesTable, eq(tenantFunnelTypesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId))
    .orderBy(tenantFunnelTypesTable.funnelTypeId)
    .limit(1);
  const defaultFunnelName = defaultAssoc?.funnelName ?? null;

  const allCandidates = await db.execute(sql`
    WITH parsed AS (
      SELECT
        ae.id,
        ae.resolved_funnel,
        ${ROUTE_PATH_EXPR} AS route_path
      FROM attribution_events ae
      WHERE ae.tenant_id = ${tenantId}
        AND ae.page_url IS NOT NULL
    )
    SELECT id, resolved_funnel
    FROM parsed
    WHERE route_path = ${normPath}
  `);
  const allRows = (allCandidates.rows ?? []) as Array<{
    id: number;
    resolved_funnel: string | null;
  }>;

  const canonicalName = funnelType.name;
  const conflictingIds: number[] = [];
  for (const r of allRows) {
    const cur = (r.resolved_funnel ?? "").trim();
    if (!cur) continue;
    const isDefault =
      defaultFunnelName !== null && cur.toLowerCase() === defaultFunnelName.toLowerCase();
    if (isDefault) continue;
    if (cur.toLowerCase() === canonicalName.toLowerCase()) continue;
    conflictingIds.push(r.id);
  }

  const { updatedEventCount, updatedLeadIds, eligibleEventIds } = await backfillEventsForRouteRule(
    tenantId,
    normPath,
    numericFunnelTypeId,
    canonicalName,
    null,
    { dryRun: true, forceOverride: forceOverride === true },
  );

  const SAMPLE_LIMIT = 10;
  const sampleIds = Array.from(
    new Set([...eligibleEventIds.slice(0, SAMPLE_LIMIT), ...conflictingIds.slice(0, SAMPLE_LIMIT)]),
  );

  type SampleEvent = {
    id: number;
    pageUrl: string | null;
    resolvedFunnel: string | null;
    createdLeadId: number | null;
    createdAt: string | null;
  };
  let sampleById = new Map<number, SampleEvent>();
  if (sampleIds.length > 0) {
    const sampleRows = await db
      .select({
        id: attributionEventsTable.id,
        pageUrl: attributionEventsTable.pageUrl,
        resolvedFunnel: attributionEventsTable.resolvedFunnel,
        createdLeadId: attributionEventsTable.createdLeadId,
        createdAt: attributionEventsTable.createdAt,
      })
      .from(attributionEventsTable)
      .where(and(
        eq(attributionEventsTable.tenantId, tenantId),
        inArray(attributionEventsTable.id, sampleIds),
      ));
    sampleById = new Map(
      sampleRows.map((r) => [
        r.id,
        {
          id: r.id,
          pageUrl: r.pageUrl ?? null,
          resolvedFunnel: r.resolvedFunnel ?? null,
          createdLeadId: r.createdLeadId ?? null,
          createdAt: r.createdAt instanceof Date
            ? r.createdAt.toISOString()
            : (typeof r.createdAt === "string" ? new Date(r.createdAt).toISOString() : null),
        },
      ]),
    );
  }

  const eligibleSample = eligibleEventIds
    .slice(0, SAMPLE_LIMIT)
    .map((id) => sampleById.get(id))
    .filter((e): e is SampleEvent => !!e);
  const conflictingSample = conflictingIds
    .slice(0, SAMPLE_LIMIT)
    .map((id) => sampleById.get(id))
    .filter((e): e is SampleEvent => !!e);

  res.json({
    routePath: normPath,
    funnelTypeId: numericFunnelTypeId,
    funnelName: canonicalName,
    updatedEventCount,
    updatedLeadCount: updatedLeadIds.length,
    conflictingEventCount: conflictingIds.length,
    matchedEventCount: allRows.length,
    eligibleSample,
    conflictingSample,
    forceOverride: forceOverride === true,
  });
});

router.post("/route-funnel-rules", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const { routePath, funnelTypeId, forceOverride } = req.body as {
    routePath?: string;
    funnelTypeId?: number | string;
    forceOverride?: boolean;
  };
  if (!routePath || typeof routePath !== "string" || !funnelTypeId) {
    res.status(400).json({ error: "routePath and funnelTypeId are required" });
    return;
  }

  const normPath = normalizeRoutePath(routePath);
  if (!normPath) {
    res.status(400).json({ error: "routePath cannot be empty" });
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
    .from(routeFunnelRulesTable)
    .where(and(
      eq(routeFunnelRulesTable.tenantId, tenantId),
      eq(routeFunnelRulesTable.routePath, normPath),
    ));

  let ruleId: number;
  let created: boolean;
  let priorFunnelName: string | null = null;
  if (existing.length > 0) {
    if (existing[0].funnelTypeId === numericFunnelTypeId) {
      ruleId = existing[0].id;
      created = false;
    } else {
      const [priorFunnel] = await db
        .select({ name: funnelTypesTable.name })
        .from(funnelTypesTable)
        .where(eq(funnelTypesTable.id, existing[0].funnelTypeId));
      priorFunnelName = priorFunnel?.name ?? null;
      const [updated] = await db
        .update(routeFunnelRulesTable)
        .set({ funnelTypeId: numericFunnelTypeId })
        .where(eq(routeFunnelRulesTable.id, existing[0].id))
        .returning();
      ruleId = updated.id;
      created = false;
    }
  } else {
    const [inserted] = await db
      .insert(routeFunnelRulesTable)
      .values({ tenantId, funnelTypeId: numericFunnelTypeId, routePath: normPath })
      .returning();
    ruleId = inserted.id;
    created = true;
  }

  invalidateRouteFunnelCache(tenantId);

  await db
    .delete(routeSuggestionDismissalsTable)
    .where(and(
      eq(routeSuggestionDismissalsTable.tenantId, tenantId),
      eq(routeSuggestionDismissalsTable.routePath, normPath),
    ));

  const { updatedEventCount, updatedLeadIds, priorEventValues, priorLeadValues } = await backfillEventsForRouteRule(
    tenantId,
    normPath,
    numericFunnelTypeId,
    funnelType.name,
    priorFunnelName,
    { forceOverride: forceOverride === true },
  );

  let undoBatchId: string | null = null;
  if (forceOverride === true && (priorEventValues.length > 0 || priorLeadValues.length > 0)) {
    pruneUndoBatches();
    undoBatchId = randomUUID();
    undoBatches.set(undoBatchId, {
      tenantId,
      routePath: normPath,
      createdAt: Date.now(),
      events: priorEventValues,
      leads: priorLeadValues,
    });
  }

  res.json({
    rule: {
      id: ruleId,
      tenantId,
      routePath: normPath,
      funnelTypeId: numericFunnelTypeId,
      funnelName: funnelType.name,
    },
    created,
    updatedEventCount,
    updatedLeadCount: updatedLeadIds.length,
    forceOverride: forceOverride === true,
    undoBatchId,
    undoExpiresAt: undoBatchId ? Date.now() + UNDO_WINDOW_MS : null,
  });
});

router.post("/route-funnel-rules/undo/:batchId", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }
  const batchId = req.params.batchId;
  pruneUndoBatches();
  const batch = undoBatches.get(batchId);
  if (!batch || batch.tenantId !== tenantId) {
    res.status(404).json({ error: "Undo window has expired" });
    return;
  }

  const eventsByPrior = new Map<string, number[]>();
  for (const e of batch.events) {
    const key = e.resolvedFunnel === null ? "\0null" : `v:${e.resolvedFunnel}`;
    const arr = eventsByPrior.get(key) ?? [];
    arr.push(e.id);
    eventsByPrior.set(key, arr);
  }
  for (const [key, ids] of eventsByPrior.entries()) {
    const value = key === "\0null" ? null : key.slice(2);
    await db
      .update(attributionEventsTable)
      .set({ resolvedFunnel: value })
      .where(and(
        eq(attributionEventsTable.tenantId, tenantId),
        inArray(attributionEventsTable.id, ids),
      ));
  }

  const leadsByPrior = new Map<string, number[]>();
  for (const l of batch.leads) {
    const key = `${l.leadType ?? "\0null"}::${l.funnelId ?? "\0null"}`;
    const arr = leadsByPrior.get(key) ?? [];
    arr.push(l.id);
    leadsByPrior.set(key, arr);
  }
  for (const [, ids] of leadsByPrior.entries()) {
    const sample = batch.leads.find((l) => ids.includes(l.id))!;
    await db
      .update(leadsTable)
      .set({ leadType: sample.leadType, funnelId: sample.funnelId, updatedAt: new Date() })
      .where(and(
        eq(leadsTable.tenantId, tenantId),
        inArray(leadsTable.id, ids),
      ));
  }

  undoBatches.delete(batchId);
  invalidateRouteFunnelCache(tenantId);

  res.json({
    success: true,
    revertedEventCount: batch.events.length,
    revertedLeadCount: batch.leads.length,
    routePath: batch.routePath,
  });
});

// Revert: when a rule is removed with ?revertEvents=true, re-resolve historical
// attribution events on the rule's route path whose resolved_funnel currently
// equals the (deleted) rule's funnel name back to the tenant's default funnel.
// Same guardrails as the backfill: never clobber an unrelated retag, and never
// touch a per-lead override.
async function revertEventsForRouteRule(
  tenantId: number,
  routePath: string,
  ruleFunnelName: string,
): Promise<{ updatedEventCount: number; updatedLeadIds: number[] }> {
  const normPath = normalizeRoutePath(routePath);
  if (!normPath) return { updatedEventCount: 0, updatedLeadIds: [] };
  const ruleLc = ruleFunnelName.toLowerCase();

  const [defaultAssoc] = await db
    .select({ funnelId: funnelTypesTable.id, funnelName: funnelTypesTable.name })
    .from(tenantFunnelTypesTable)
    .innerJoin(funnelTypesTable, eq(tenantFunnelTypesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId))
    .orderBy(tenantFunnelTypesTable.funnelTypeId)
    .limit(1);
  const defaultFunnelName = defaultAssoc?.funnelName ?? null;
  const defaultFunnelId = defaultAssoc?.funnelId ?? null;

  const candidates = await db.execute(sql`
    WITH parsed AS (
      SELECT
        ae.id,
        ae.created_lead_id,
        ae.resolved_funnel,
        ${ROUTE_PATH_EXPR} AS route_path
      FROM attribution_events ae
      WHERE ae.tenant_id = ${tenantId}
        AND ae.page_url IS NOT NULL
    )
    SELECT id, created_lead_id, resolved_funnel
    FROM parsed
    WHERE route_path = ${normPath}
  `);

  const rows = (candidates.rows ?? []) as Array<{
    id: number;
    created_lead_id: number | null;
    resolved_funnel: string | null;
  }>;

  const overriddenLeadIds = await loadOverriddenLeadIds(
    tenantId,
    rows.map((r) => r.created_lead_id),
  );

  const eligibleIds: number[] = [];
  const leadIdSet = new Set<number>();
  for (const r of rows) {
    if (r.created_lead_id && overriddenLeadIds.has(r.created_lead_id)) continue;
    const cur = (r.resolved_funnel ?? "").trim();
    if (!cur) continue;
    if (cur.toLowerCase() !== ruleLc) continue;
    eligibleIds.push(r.id);
    if (r.created_lead_id) leadIdSet.add(r.created_lead_id);
  }

  if (eligibleIds.length > 0) {
    await db
      .update(attributionEventsTable)
      .set({ resolvedFunnel: defaultFunnelName })
      .where(and(
        eq(attributionEventsTable.tenantId, tenantId),
        inArray(attributionEventsTable.id, eligibleIds),
      ));
  }

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
      if (cur.toLowerCase() !== ruleLc) continue;
      toUpdate.push(l.id);
    }
    if (toUpdate.length > 0) {
      await db
        .update(leadsTable)
        .set({ leadType: defaultFunnelName, funnelId: defaultFunnelId, updatedAt: new Date() })
        .where(and(
          eq(leadsTable.tenantId, tenantId),
          inArray(leadsTable.id, toUpdate),
        ));
      updatedLeadIds.push(...toUpdate);
    }
  }

  return { updatedEventCount: eligibleIds.length, updatedLeadIds };
}

router.delete("/route-funnel-rules/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(routeFunnelRulesTable)
    .where(eq(routeFunnelRulesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  const access = assertResourceTenantAccess(req, res, existing.tenantId, {
    notFoundOnMismatch: true,
    notFoundMessage: "Rule not found",
  });
  if (!access.ok) return;

  const revertEvents = String(req.query.revertEvents ?? "").toLowerCase() === "true";

  let ruleFunnelName: string | null = null;
  if (revertEvents) {
    const [funnel] = await db
      .select({ name: funnelTypesTable.name })
      .from(funnelTypesTable)
      .where(eq(funnelTypesTable.id, existing.funnelTypeId));
    ruleFunnelName = funnel?.name ?? null;
  }

  await db.delete(routeFunnelRulesTable).where(eq(routeFunnelRulesTable.id, id));
  invalidateRouteFunnelCache(existing.tenantId);

  if (revertEvents && ruleFunnelName) {
    const { updatedEventCount, updatedLeadIds } = await revertEventsForRouteRule(
      existing.tenantId,
      existing.routePath,
      ruleFunnelName,
    );
    res.json({
      success: true,
      reverted: true,
      updatedEventCount,
      updatedLeadCount: updatedLeadIds.length,
    });
    return;
  }

  res.json({ success: true });
});

export default router;
