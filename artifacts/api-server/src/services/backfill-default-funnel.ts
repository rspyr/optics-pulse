import {
  db,
  attributionEventsTable,
  leadsTable,
  funnelTypesTable,
  tenantFunnelTypesTable,
} from "@workspace/db";
import { and, eq, desc, inArray, isNotNull } from "drizzle-orm";
import { detectFields } from "./field-detection";
import { normalizeFunnel } from "./funnel-normalizer";
import { resolveSubdomainFunnel } from "./subdomain-funnel-resolver";

export interface BackfillDefaultFunnelResult {
  tenantId: number;
  defaultFunnelName: string | null;
  candidateEvents: number;
  clearedEvents: number;
  clearedLeads: number;
  leadsSkippedDueToOverride: number;
  leadsSkippedDueToLaterMatch: number;
  dryRun: boolean;
}

/**
 * Backfill cleaner for events that were stamped with the tenant's "default"
 * funnel purely by the pre-task-#575 fallback (the now-removed "first active
 * funnel" guess). For each event whose `resolved_funnel` still equals the
 * default funnel name we re-run the live resolver waterfall in tracker.ts —
 * `_custom.funnel` → detected funnel field alias → URL path alias → subdomain
 * rule. If none of those would resolve the event today, the value was
 * exclusively the old fallback and we clear `resolved_funnel` to null.
 *
 * After the event sweep, we look at every lead whose events were touched and,
 * unless `funnel_overridden_at IS NOT NULL`, clear `funnel_id` / `lead_type`
 * when the lead's MOST RECENT event is now unmatched. We don't touch
 * `service_type` (lead-level field set from raw funnel signal, not the old
 * fallback) and we leave leads alone whose latest event still has a real
 * `resolved_funnel`.
 *
 * Idempotent: re-running finds zero candidate rows once cleared. `dryRun:true`
 * returns the same counts without writing.
 */
export async function backfillDefaultFunnelForTenant(
  tenantId: number,
  options: { dryRun?: boolean } = {},
): Promise<BackfillDefaultFunnelResult> {
  const dryRun = options.dryRun === true;

  // Mirror the OLD fallback: first active funnel for the tenant ordered by
  // funnel_type_id. Same SQL shape used by the subdomain-rule backfill so the
  // two stay in sync.
  const [defaultAssoc] = await db
    .select({ funnelName: funnelTypesTable.name })
    .from(tenantFunnelTypesTable)
    .innerJoin(funnelTypesTable, eq(tenantFunnelTypesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId))
    .orderBy(tenantFunnelTypesTable.funnelTypeId)
    .limit(1);
  const defaultFunnelName = defaultAssoc?.funnelName ?? null;

  if (!defaultFunnelName) {
    return {
      tenantId,
      defaultFunnelName: null,
      candidateEvents: 0,
      clearedEvents: 0,
      clearedLeads: 0,
      leadsSkippedDueToOverride: 0,
      leadsSkippedDueToLaterMatch: 0,
      dryRun,
    };
  }

  // Candidates: events whose current resolved_funnel exactly matches the
  // default funnel name (case-insensitive). Events resolved by alias /
  // subdomain / URL path will already carry the canonical (different)
  // funnel name and are skipped — they weren't the fallback case.
  const candidates = await db
    .select({
      id: attributionEventsTable.id,
      createdLeadId: attributionEventsTable.createdLeadId,
      formFields: attributionEventsTable.formFields,
      pageUrl: attributionEventsTable.pageUrl,
      formId: attributionEventsTable.formId,
      formName: attributionEventsTable.formName,
      resolvedFunnel: attributionEventsTable.resolvedFunnel,
    })
    .from(attributionEventsTable)
    .where(and(
      eq(attributionEventsTable.tenantId, tenantId),
      isNotNull(attributionEventsTable.resolvedFunnel),
    ));

  const defaultLc = defaultFunnelName.toLowerCase();
  const toClear: number[] = [];
  const affectedLeadIds = new Set<number>();
  let candidateCount = 0;

  for (const ev of candidates) {
    const cur = (ev.resolvedFunnel ?? "").trim().toLowerCase();
    if (cur !== defaultLc) continue;
    candidateCount++;

    // Mirror tracker.ts resolver waterfall (Task #575) — order matters:
    //   1. _custom.funnel slug → resolveFunnelType
    //   2. detected funnel field value → normalizeFunnel alias OR raw value
    //   3. URL path → normalizeFunnel(pagePath)
    //   4. subdomain → resolveSubdomainFunnel
    // If ANY of these would produce a resolved_funnel today, the row was a
    // real match (or would now match via a rule added since) — leave it
    // alone. If none fire, the row was only ever the old default fallback.
    const fields = (ev.formFields && typeof ev.formFields === "object")
      ? (ev.formFields as Record<string, unknown>)
      : {};
    const custom = (fields._custom && typeof fields._custom === "object")
      ? (fields._custom as Record<string, unknown>)
      : {};

    let wouldResolve = false;

    // 1. _custom.funnel slug
    const funnelSlug = typeof custom.funnel === "string" ? custom.funnel : null;
    if (funnelSlug) {
      const [ft] = await db
        .select({ id: funnelTypesTable.id })
        .from(funnelTypesTable)
        .innerJoin(tenantFunnelTypesTable, and(
          eq(tenantFunnelTypesTable.funnelTypeId, funnelTypesTable.id),
          eq(tenantFunnelTypesTable.tenantId, tenantId),
        ))
        .where(eq(funnelTypesTable.slug, funnelSlug))
        .limit(1);
      if (ft) wouldResolve = true;
    }

    // 2. detected funnel field value → alias / raw
    if (!wouldResolve) {
      // detectFields needs the customer-visible fields (no `_custom`); the
      // stored blob already separates them but defensively drop `_*` keys.
      const visibleFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (!k.startsWith("_")) visibleFields[k] = v;
      }
      const detection = await detectFields(
        tenantId,
        visibleFields,
        ev.pageUrl ?? null,
        ev.formId ?? null,
        ev.formName ?? null,
      );
      if (detection.funnelRawValue) {
        // tracker.ts sets resolvedFunnelStr to either alias canonical name
        // OR the raw value itself — either way it counts as "would have
        // resolved to something other than the fallback".
        wouldResolve = true;
      }
    }

    // 3. URL path alias
    if (!wouldResolve && ev.pageUrl) {
      try {
        const pagePath = new URL(ev.pageUrl).pathname.toLowerCase();
        const urlAlias = await normalizeFunnel(tenantId, pagePath);
        if (urlAlias) wouldResolve = true;
      } catch {
        // Malformed URL — falls through; not a resolver match either.
      }
    }

    // 4. subdomain rule
    if (!wouldResolve && ev.pageUrl) {
      const sub = await resolveSubdomainFunnel(tenantId, ev.pageUrl);
      if (sub) wouldResolve = true;
    }

    if (wouldResolve) continue;

    toClear.push(ev.id);
    if (ev.createdLeadId) affectedLeadIds.add(ev.createdLeadId);
  }

  if (toClear.length > 0 && !dryRun) {
    // Chunk the IN list to keep the parameter count modest.
    const CHUNK = 500;
    for (let i = 0; i < toClear.length; i += CHUNK) {
      const slice = toClear.slice(i, i + CHUNK);
      await db
        .update(attributionEventsTable)
        .set({ resolvedFunnel: null })
        .where(and(
          eq(attributionEventsTable.tenantId, tenantId),
          inArray(attributionEventsTable.id, slice),
        ));
    }
  }

  // Lead-side propagation: for every affected lead, check the most recent
  // event. If it's now unmatched AND the lead has no per-lead override,
  // clear funnel_id / lead_type. Respect overrides explicitly per the spec.
  let clearedLeads = 0;
  let leadsSkippedDueToOverride = 0;
  let leadsSkippedDueToLaterMatch = 0;

  if (affectedLeadIds.size > 0) {
    const leadIds = Array.from(affectedLeadIds);
    const leads = await db
      .select({
        id: leadsTable.id,
        funnelId: leadsTable.funnelId,
        leadType: leadsTable.leadType,
        funnelOverriddenAt: leadsTable.funnelOverriddenAt,
      })
      .from(leadsTable)
      .where(and(
        eq(leadsTable.tenantId, tenantId),
        inArray(leadsTable.id, leadIds),
      ));

    // Build a lookup of clearedEventIds so we evaluate the lead's latest
    // event using post-backfill values (the DB row may not be updated yet
    // in dryRun mode, but the in-memory view is what matters).
    const clearedSet = new Set(toClear);
    const leadsToClear: number[] = [];

    for (const lead of leads) {
      if (lead.funnelOverriddenAt != null) {
        leadsSkippedDueToOverride++;
        continue;
      }

      const [latest] = await db
        .select({
          id: attributionEventsTable.id,
          resolvedFunnel: attributionEventsTable.resolvedFunnel,
        })
        .from(attributionEventsTable)
        .where(and(
          eq(attributionEventsTable.tenantId, tenantId),
          eq(attributionEventsTable.createdLeadId, lead.id),
        ))
        .orderBy(desc(attributionEventsTable.createdAt))
        .limit(1);

      if (!latest) {
        // Shouldn't really happen (the lead was added via an event) but if
        // there's no event there's nothing to derive from — treat as
        // unmatched.
        leadsToClear.push(lead.id);
        continue;
      }

      // Effective resolved funnel after the sweep: null when the latest
      // event is in our cleared set or already null.
      const effective = clearedSet.has(latest.id) ? null : latest.resolvedFunnel;
      if (effective == null) {
        // Only count as "to clear" if the lead actually still carries a
        // funnel — leads already at null are a no-op and shouldn't show in
        // the cleared count.
        if (lead.funnelId != null || lead.leadType != null) {
          leadsToClear.push(lead.id);
        }
      } else {
        leadsSkippedDueToLaterMatch++;
      }
    }

    if (leadsToClear.length > 0) {
      if (!dryRun) {
        const CHUNK = 500;
        for (let i = 0; i < leadsToClear.length; i += CHUNK) {
          const slice = leadsToClear.slice(i, i + CHUNK);
          await db
            .update(leadsTable)
            .set({ funnelId: null, leadType: null, updatedAt: new Date() })
            .where(and(
              eq(leadsTable.tenantId, tenantId),
              inArray(leadsTable.id, slice),
            ));
        }
      }
      clearedLeads = leadsToClear.length;
    }
  }

  const summary: BackfillDefaultFunnelResult = {
    tenantId,
    defaultFunnelName,
    candidateEvents: candidateCount,
    clearedEvents: toClear.length,
    clearedLeads,
    leadsSkippedDueToOverride,
    leadsSkippedDueToLaterMatch,
    dryRun,
  };

  console.info(
    `[backfill-default-funnel] tenant=${tenantId} default="${defaultFunnelName}" ` +
    `candidates=${summary.candidateEvents} cleared_events=${summary.clearedEvents} ` +
    `cleared_leads=${summary.clearedLeads} skipped_override=${summary.leadsSkippedDueToOverride} ` +
    `skipped_later_match=${summary.leadsSkippedDueToLaterMatch} dry_run=${dryRun}`,
  );

  return summary;
}
