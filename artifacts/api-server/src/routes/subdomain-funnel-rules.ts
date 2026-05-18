import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db,
  subdomainFunnelRulesTable,
  subdomainSuggestionDismissalsTable,
  funnelTypesTable,
  tenantFunnelTypesTable,
  attributionEventsTable,
  leadsTable,
  funnelAliasesTable,
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
  priorFunnelName: string | null = null,
  options: { dryRun?: boolean; forceOverride?: boolean } = {},
): Promise<{ updatedEventCount: number; updatedLeadIds: number[]; eligibleEventIds: number[] }> {
  const dryRun = options.dryRun === true;
  const forceOverride = options.forceOverride === true;
  const normSub = subdomain.toLowerCase().trim();
  if (!normSub) return { updatedEventCount: 0, updatedLeadIds: [], eligibleEventIds: [] };
  const priorLc = priorFunnelName?.toLowerCase() ?? null;

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
    lower(substring(ae.page_url from '^https?://([^/?#]+)')),
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
  const newLc = canonicalFunnelName.toLowerCase();
  for (const r of rows) {
    const cur = (r.resolved_funnel ?? "").trim();
    const curLc = cur.toLowerCase();
    const isFellThrough =
      !cur ||
      (defaultFunnelName !== null && curLc === defaultFunnelName.toLowerCase());
    // When re-pointing an existing rule, also reclaim events that
    // previously matched the prior rule's funnel — those rows were
    // attributed by this same subdomain rule and should follow it.
    const isPriorRuleMatch = priorLc !== null && priorLc !== newLc && curLc === priorLc;
    if (curLc === newLc) continue;
    if (!isFellThrough && !isPriorRuleMatch && !forceOverride) continue;
    eligibleIds.push(r.id);
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
      const curLc = cur.toLowerCase();
      const isFellThrough =
        !cur ||
        (defaultFunnelName !== null && curLc === defaultFunnelName.toLowerCase());
      const isPriorRuleMatch = priorLc !== null && priorLc !== newLc && curLc === priorLc;
      const isCanonical = curLc === newLc;
      if (isCanonical && l.funnelId === funnelTypeId) continue;
      if (!isFellThrough && !isPriorRuleMatch && !isCanonical && !forceOverride) continue;
      toUpdate.push(l.id);
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

  return { updatedEventCount: eligibleIds.length, updatedLeadIds, eligibleEventIds: eligibleIds };
}

// Suggest subdomain → funnel rules from historical attribution events.
// A subdomain is suggested when:
//   * It is not already covered by an existing rule.
//   * Within the last 90 days, every event whose resolved_funnel is set to a
//     non-default value points at the same funnel (i.e. the subdomain has
//     "only ever served one funnel" — reason: "observed"). Fell-through
//     events (null/empty or the tenant's default funnel) are counted toward
//     the backfill opportunity but do not count as a competing funnel signal.
//   * OR every event on the subdomain has only ever fallen through to the
//     default funnel AND the subdomain label heuristically matches the name
//     of exactly one non-default tenant funnel (reason: "label-match"). This
//     surfaces brand-new subdomains like "protect." that were never tagged
//     correctly but clearly map to a tenant funnel by naming convention.
//   * That funnel is enabled for the tenant.
//   * At least 3 events were observed on the subdomain in the window, to
//     avoid noise from one-off traffic.
//
// One-click accept happens via the existing POST /subdomain-funnel-rules,
// which creates the rule and re-resolves matching past events.
router.get("/subdomain-funnel-rules/suggestions", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.json({ suggestions: [], hiddenSubdomains: [] });
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
    .select({ subdomain: subdomainFunnelRulesTable.subdomain })
    .from(subdomainFunnelRulesTable)
    .where(eq(subdomainFunnelRulesTable.tenantId, tenantId));
  const ruled = new Set(existingRules.map(r => r.subdomain.toLowerCase()));

  // Per-user dismissals (task #448). We compute suggestions normally, then
  // partition into visible vs hidden so the UI can render an "N hidden — show"
  // affordance without a second round-trip.
  const dismissedRows = userId
    ? await db
        .select({ subdomain: subdomainSuggestionDismissalsTable.subdomain })
        .from(subdomainSuggestionDismissalsTable)
        .where(and(
          eq(subdomainSuggestionDismissalsTable.tenantId, tenantId),
          eq(subdomainSuggestionDismissalsTable.userId, userId),
        ))
    : [];
  const dismissed = new Set(dismissedRows.map(r => r.subdomain.toLowerCase()));

  const hostExpr = sql`regexp_replace(
    lower(substring(ae.page_url from '^https?://([^/?#]+)')),
    '^www\\.', ''
  )`;

  const grouped = await db.execute(sql`
    WITH parsed AS (
      SELECT
        ae.resolved_funnel,
        string_to_array(${hostExpr}, '.') AS parts
      FROM attribution_events ae
      WHERE ae.tenant_id = ${tenantId}
        AND ae.page_url IS NOT NULL
        AND ae.created_at > now() - interval '90 days'
    )
    SELECT
      array_to_string(parts[1:array_length(parts, 1) - 2], '.') AS subdomain,
      resolved_funnel,
      count(*)::int AS cnt
    FROM parsed
    WHERE array_length(parts, 1) >= 3
    GROUP BY subdomain, resolved_funnel
  `);

  type Row = { subdomain: string; resolved_funnel: string | null; cnt: number };
  const rows = (grouped.rows ?? []) as Row[];

  const bySub = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.subdomain) continue;
    if (ruled.has(r.subdomain)) continue;
    const arr = bySub.get(r.subdomain) ?? [];
    arr.push(r);
    bySub.set(r.subdomain, arr);
  }

  const suggestions: Array<{
    subdomain: string;
    suggestedFunnelTypeId: number;
    suggestedFunnelName: string;
    eventCount: number;
    fellThroughCount: number;
    reason: "observed" | "label-match";
    matchedAlias?: string;
  }> = [];

  // Tokenize a string into lowercase alphanumeric chunks for the label-match
  // heuristic. We split on dots, dashes, underscores, and whitespace so that
  // "Home Protection" and "protect" can still find each other via shared
  // tokens / substrings.
  const tokenize = (s: string): string[] =>
    s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  // Pre-tokenize tenant funnels once for the heuristic. Exclude the default
  // funnel from heuristic matching — we never want to suggest a rule that
  // points back at the funnel traffic is already falling through to.
  // We also fold in tenant-configured funnel aliases as additional match
  // surfaces, since aliases (e.g. "protection", "shield") are often richer
  // signal than the canonical funnel name.
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

  for (const [subdomain, srows] of bySub.entries()) {
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
        subdomain,
        suggestedFunnelTypeId: funnel.id,
        suggestedFunnelName: funnel.name,
        eventCount: total,
        fellThroughCount: fellThrough,
        reason: "observed",
      });
      continue;
    }

    // Default-funnel-only subdomain (no competing non-default signal yet).
    // Try to infer a funnel from the subdomain label. We only suggest when
    // exactly one tenant funnel matches, to avoid steering the operator into
    // a wrong rule. A token (>=4 chars to avoid stop-word collisions) on
    // either side must be a substring of the other's full name, OR the two
    // share at least one exact token.
    if (distinctFunnels.size === 0 && fellThrough >= 3 && heuristicFunnels.length > 0) {
      const subTokens = tokenize(subdomain);
      if (subTokens.length === 0) continue;
      const subLc = subdomain.toLowerCase();
      // For each candidate funnel, find why it matched (if at all). A name
      // match wins over an alias match for explanation purposes; if only an
      // alias matched, we surface which alias it was.
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
        // Try alias matches with the same heuristic.
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
        subdomain,
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

  const visible = suggestions.filter(s => !dismissed.has(s.subdomain.toLowerCase()));
  const hiddenSubdomains = suggestions
    .filter(s => dismissed.has(s.subdomain.toLowerCase()))
    .map(s => s.subdomain);

  res.json({ suggestions: visible, hiddenSubdomains });
});

// Persist a per-(tenant, user) dismissal so a suggestion stays hidden across
// refreshes. We accept any subdomain string (normalized) — even if it isn't
// currently in the suggestions list — so the UI can dismiss optimistically.
router.post("/subdomain-funnel-rules/suggestions/dismiss", async (req, res) => {
  const tenantId = resolveTenantId(req);
  const userId = req.session.userId ?? null;
  if (!tenantId || !userId) {
    res.status(400).json({ error: "No tenant or user context" });
    return;
  }
  const { subdomain } = req.body as { subdomain?: string };
  if (!subdomain || typeof subdomain !== "string") {
    res.status(400).json({ error: "subdomain is required" });
    return;
  }
  const normSub = normalizeSubdomain(subdomain);
  if (!normSub) {
    res.status(400).json({ error: "subdomain cannot be empty" });
    return;
  }

  await db
    .insert(subdomainSuggestionDismissalsTable)
    .values({ tenantId, userId, subdomain: normSub })
    .onConflictDoNothing({
      target: [
        subdomainSuggestionDismissalsTable.tenantId,
        subdomainSuggestionDismissalsTable.userId,
        subdomainSuggestionDismissalsTable.subdomain,
      ],
    });

  res.json({ success: true });
});

// Undo dismissals. With no body, clears every dismissal this user has for the
// current tenant (the "show N hidden" link). With a `subdomain`, clears just
// that one.
router.post("/subdomain-funnel-rules/suggestions/undo-dismiss", async (req, res) => {
  const tenantId = resolveTenantId(req);
  const userId = req.session.userId ?? null;
  if (!tenantId || !userId) {
    res.status(400).json({ error: "No tenant or user context" });
    return;
  }
  const { subdomain } = (req.body ?? {}) as { subdomain?: string };

  if (subdomain && typeof subdomain === "string") {
    const normSub = normalizeSubdomain(subdomain);
    await db
      .delete(subdomainSuggestionDismissalsTable)
      .where(and(
        eq(subdomainSuggestionDismissalsTable.tenantId, tenantId),
        eq(subdomainSuggestionDismissalsTable.userId, userId),
        eq(subdomainSuggestionDismissalsTable.subdomain, normSub),
      ));
  } else {
    await db
      .delete(subdomainSuggestionDismissalsTable)
      .where(and(
        eq(subdomainSuggestionDismissalsTable.tenantId, tenantId),
        eq(subdomainSuggestionDismissalsTable.userId, userId),
      ));
  }

  res.json({ success: true });
});

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

router.post("/subdomain-funnel-rules/preview", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const { subdomain, funnelTypeId, forceOverride } = req.body as {
    subdomain?: string;
    funnelTypeId?: number | string;
    forceOverride?: boolean;
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

  // Identify how many historical events match this subdomain at all (any
  // resolved funnel) and how many of those are still on a *different*,
  // non-fall-through funnel — those would be skipped by the actual backfill
  // and represent a "conflict" the operator should know about.
  const hostExpr = sql`regexp_replace(
    lower(substring(ae.page_url from '^https?://([^/?#]+)')),
    '^www\\.', ''
  )`;
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
        string_to_array(${hostExpr}, '.') AS parts
      FROM attribution_events ae
      WHERE ae.tenant_id = ${tenantId}
        AND ae.page_url IS NOT NULL
    )
    SELECT id, resolved_funnel
    FROM parsed
    WHERE array_length(parts, 1) >= 3
      AND array_to_string(parts[1:array_length(parts, 1) - 2], '.') = ${normSub}
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

  const { updatedEventCount, updatedLeadIds, eligibleEventIds } = await backfillEventsForSubdomainRule(
    tenantId,
    normSub,
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
    subdomain: normSub,
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

router.post("/subdomain-funnel-rules", async (req, res) => {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: "No tenant context" });
    return;
  }

  const { subdomain, funnelTypeId, forceOverride } = req.body as {
    subdomain?: string;
    funnelTypeId?: number | string;
    forceOverride?: boolean;
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
  let priorFunnelName: string | null = null;
  if (existing.length > 0) {
    if (existing[0].funnelTypeId === numericFunnelTypeId) {
      ruleId = existing[0].id;
      created = false;
    } else {
      // Look up the prior funnel's canonical name so the backfill can also
      // reclaim events that previously matched the OLD rule's funnel.
      const [priorFunnel] = await db
        .select({ name: funnelTypesTable.name })
        .from(funnelTypesTable)
        .where(eq(funnelTypesTable.id, existing[0].funnelTypeId));
      priorFunnelName = priorFunnel?.name ?? null;
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

  // Clear any per-user dismissals for this (tenant, subdomain). Once a rule
  // covers the subdomain the suggestions endpoint filters it out anyway, so
  // the dismissal rows are dead weight; deleting them also means that if the
  // rule is later removed, the suggestion can resurface for operators.
  await db
    .delete(subdomainSuggestionDismissalsTable)
    .where(and(
      eq(subdomainSuggestionDismissalsTable.tenantId, tenantId),
      eq(subdomainSuggestionDismissalsTable.subdomain, normSub),
    ));

  const { updatedEventCount, updatedLeadIds } = await backfillEventsForSubdomainRule(
    tenantId,
    normSub,
    numericFunnelTypeId,
    funnelType.name,
    priorFunnelName,
    { forceOverride: forceOverride === true },
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
    forceOverride: forceOverride === true,
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
