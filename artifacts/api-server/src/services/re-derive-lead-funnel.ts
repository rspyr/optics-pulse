import { db, leadsTable, attributionEventsTable, fieldMappingRulesTable } from "@workspace/db";
import { eq, and, desc, gte, lt, inArray } from "drizzle-orm";
import { detectFields, extractPagePath, getFormIdentifier } from "./field-detection";
import { normalizeFunnel } from "./funnel-normalizer";

/**
 * Marker error for re-derive failures that obviously won't recover on retry —
 * e.g. malformed inputs from the caller, a missing/invalid tenantId, or any
 * validation failure inside the fan-out. The job handler uses the `name` (not
 * `instanceof`, which is fragile across module reloads in tests) to skip
 * in-handler retries and surface `rule-rederive-failed` immediately instead
 * of burning two backoff sleeps for an error that's never going to resolve.
 */
export class NonRetryableReDeriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableReDeriveError";
  }
}

export interface RederiveResult {
  changed: boolean;
  leadId: number;
  funnelId: number | null;
  leadType: string | null;
  serviceType: string | null;
  eventRecomputed: boolean;
  /** True when the lead has a per-lead override and lead-row funnel columns were left untouched. */
  leadOverrideRespected: boolean;
}

export interface EventRedetectionResult {
  changed: boolean;
  eventId: number;
  resolvedFunnel: string | null;
  detectedMappings: Record<string, unknown> | null;
}

/**
 * Recompute field detection + funnel normalization for a single attribution
 * event and persist the result onto that event row's `detected_mappings` +
 * `resolved_funnel` columns. This is the event-row-only counterpart to
 * `reDeriveLeadFunnel`: it never touches `leads.*`, so it's safe to call for
 * events whose `created_lead_id` is null or doesn't match the lead currently
 * being viewed (the case that previously caused the Auto-Detected Fields
 * panel to silently snap back after save — task #549).
 */
export async function redetectAndPersistEvent(
  tenantId: number,
  eventId: number,
): Promise<EventRedetectionResult | null> {
  const [event] = await db
    .select()
    .from(attributionEventsTable)
    .where(and(
      eq(attributionEventsTable.tenantId, tenantId),
      eq(attributionEventsTable.id, eventId),
    ))
    .limit(1);
  if (!event) return null;

  let nextDetectedMappings: Record<string, unknown> | null = null;
  let nextResolvedFunnel: string | null = event.resolvedFunnel;

  if (event.formFields && typeof event.formFields === "object") {
    const detection = await detectFields(
      tenantId,
      event.formFields as Record<string, unknown>,
      event.pageUrl ?? null,
      event.formId ?? null,
      event.formName ?? null,
    );
    nextDetectedMappings = detection.fields.length > 0
      ? Object.fromEntries(detection.fields.map(f => [
          f.fieldName,
          { mapsTo: f.mapsTo, method: f.method, confidence: f.confidence },
        ]))
      : null;

    if (detection.funnelRawValue) {
      const match = await normalizeFunnel(tenantId, detection.funnelRawValue);
      // Whether or not an alias matched, the resolved_funnel should reflect
      // the canonical name when one was found, or fall back to the raw value
      // so the dropdown / list still surfaces what came in. Only blank out
      // when nothing was detected at all.
      nextResolvedFunnel = match ? match.funnelName : detection.funnelRawValue;
    } else {
      // No funnel field detected on this event. Leave the existing
      // resolved_funnel alone — it may have been set by a subdomain rule
      // or another upstream signal we don't want to clobber here.
    }
  }

  const detectedMappingsChanged =
    JSON.stringify(nextDetectedMappings ?? null) !== JSON.stringify(event.detectedMappings ?? null);
  const resolvedFunnelChanged = (event.resolvedFunnel ?? null) !== (nextResolvedFunnel ?? null);

  if (detectedMappingsChanged || resolvedFunnelChanged) {
    await db.update(attributionEventsTable)
      .set({
        detectedMappings: nextDetectedMappings,
        resolvedFunnel: nextResolvedFunnel,
      })
      .where(eq(attributionEventsTable.id, event.id));
  }

  return {
    changed: detectedMappingsChanged || resolvedFunnelChanged,
    eventId: event.id,
    resolvedFunnel: nextResolvedFunnel,
    detectedMappings: nextDetectedMappings,
  };
}

/**
 * Re-run field detection and funnel normalization for a single lead. When the
 * caller supplies an `attributionEventId`, that event's `detected_mappings` /
 * `resolved_funnel` columns are always re-persisted (independent of whether
 * the event's `created_lead_id` matches the lead — fixes the Auto-Detected
 * Fields panel snap-back bug from task #549). The lead-row writeback
 * (`funnelId` / `leadType` / `serviceType`) is always computed off the
 * lead's *latest* event so a save against a non-latest event can't
 * retroactively retag the lead with stale data.
 *
 * Respects per-lead overrides: when `funnel_overridden_at IS NOT NULL`, the
 * lead's funnel columns are left untouched. The targeted event row is still
 * re-persisted (audit) but `changed: false` is reported for the lead.
 */
export async function reDeriveLeadFunnel(
  tenantId: number,
  leadId: number,
  options: { attributionEventId?: number } = {},
): Promise<RederiveResult | null> {
  const [lead] = await db.select().from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) return null;

  // (1) Always recompute + persist the targeted event row if one was supplied,
  // even when its created_lead_id doesn't match the lead being re-derived.
  // This is what makes the "Auto-Detected Fields" panel reflect the new
  // saved-rule mapping on refetch.
  let eventRecomputed = false;
  if (options.attributionEventId) {
    const result = await redetectAndPersistEvent(tenantId, options.attributionEventId);
    if (result) eventRecomputed = true;
  }

  // (2) Compute the *lead*'s funnel from its latest attribution event. We
  // deliberately ignore the targeted event id here so a save made against a
  // historical/non-latest event doesn't move the lead off whatever its most
  // recent submission says.
  const [latestEvent] = await db.select()
    .from(attributionEventsTable)
    .where(and(
      eq(attributionEventsTable.tenantId, tenantId),
      eq(attributionEventsTable.createdLeadId, leadId),
    ))
    .orderBy(desc(attributionEventsTable.createdAt))
    .limit(1);

  let nextFunnelId: number | null = lead.funnelId;
  let nextLeadType: string | null = lead.leadType;
  let nextServiceType: string | null = lead.serviceType;

  if (latestEvent && latestEvent.formFields && typeof latestEvent.formFields === "object") {
    const detection = await detectFields(
      tenantId,
      latestEvent.formFields as Record<string, unknown>,
      latestEvent.pageUrl ?? null,
      latestEvent.formId ?? null,
      latestEvent.formName ?? null,
    );
    if (detection.funnelRawValue) {
      nextServiceType = detection.funnelRawValue;
      const match = await normalizeFunnel(tenantId, detection.funnelRawValue);
      if (match) {
        nextFunnelId = match.funnelTypeId;
        nextLeadType = match.funnelName;
      }
    }

    // Persist the latest event's detection too — this keeps a refetch of the
    // lead's most recent event in sync. If the targeted event happened to be
    // the latest event, redetectAndPersistEvent above already covered it; the
    // second write here is idempotent (same data) so the cost is one extra
    // UPDATE in the worst case.
    if (latestEvent.id !== options.attributionEventId) {
      try {
        await redetectAndPersistEvent(tenantId, latestEvent.id);
      } catch (err) {
        console.error("[reDeriveLeadFunnel] failed to redetect latest event:", err);
      }
    }
  }

  // Also try normalizing the lead's current stored serviceType/leadType in case
  // a fresh alias makes them resolvable even with no attribution event in play.
  if (nextFunnelId === lead.funnelId) {
    const candidate = nextServiceType || nextLeadType || lead.serviceType || lead.leadType;
    if (candidate) {
      const match = await normalizeFunnel(tenantId, candidate);
      if (match) {
        nextFunnelId = match.funnelTypeId;
        nextLeadType = match.funnelName;
      }
    }
  }

  // (3) Respect a per-lead override: never let any re-derive path silently
  // overwrite a manual correction. We still report `changed: false` so
  // upstream UI doesn't flash a "lead updated" hint.
  const leadOverrideRespected = lead.funnelOverriddenAt != null;
  if (leadOverrideRespected) {
    return {
      changed: false,
      leadId,
      funnelId: lead.funnelId,
      leadType: lead.leadType,
      serviceType: lead.serviceType,
      eventRecomputed,
      leadOverrideRespected: true,
    };
  }

  const changed =
    nextFunnelId !== lead.funnelId ||
    nextLeadType !== lead.leadType ||
    nextServiceType !== lead.serviceType;

  if (changed) {
    await db.update(leadsTable).set({
      funnelId: nextFunnelId,
      leadType: nextLeadType,
      serviceType: nextServiceType,
      updatedAt: new Date(),
    }).where(eq(leadsTable.id, leadId));
  }

  return {
    changed,
    leadId,
    funnelId: nextFunnelId,
    leadType: nextLeadType,
    serviceType: nextServiceType,
    eventRecomputed,
    leadOverrideRespected: false,
  };
}

export interface RederiveScopeResult {
  scanned: number;
  leadsConsidered: number;
  leadsChanged: number;
  hitLimit: boolean;
  maxLeads: number;
}

/**
 * Re-derive funnels for all leads whose most recent attribution event falls
 * within the (pageUrlPattern, formIdentifier) scope of a mapping rule. Used
 * after a rule is created/updated so historical leads — not just the one the
 * operator was looking at — pick up the new mapping without waiting for the
 * next ingest to touch them.
 *
 * The work is bounded by both a lookback window and a hard lead cap so the
 * caller can fire-and-forget without risking a runaway scan.
 */
export async function reDeriveLeadsForRuleScope(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
  options: { lookbackDays?: number; maxEvents?: number; maxLeads?: number; excludeLeadId?: number | null } = {},
): Promise<RederiveScopeResult> {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new NonRetryableReDeriveError(
      `reDeriveLeadsForRuleScope: invalid tenantId ${JSON.stringify(tenantId)}`,
    );
  }
  if (typeof pageUrlPattern !== "string" || pageUrlPattern.length === 0) {
    throw new NonRetryableReDeriveError(
      `reDeriveLeadsForRuleScope: invalid pageUrlPattern ${JSON.stringify(pageUrlPattern)}`,
    );
  }
  if (typeof formIdentifier !== "string" || formIdentifier.length === 0) {
    throw new NonRetryableReDeriveError(
      `reDeriveLeadsForRuleScope: invalid formIdentifier ${JSON.stringify(formIdentifier)}`,
    );
  }

  const lookbackDays = options.lookbackDays ?? 30;
  const maxEvents = options.maxEvents ?? 2000;
  const maxLeads = options.maxLeads ?? 200;
  const excludeLeadId = options.excludeLeadId ?? null;

  const lookbackDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const events = await db
    .select({
      id: attributionEventsTable.id,
      createdLeadId: attributionEventsTable.createdLeadId,
      pageUrl: attributionEventsTable.pageUrl,
      formId: attributionEventsTable.formId,
      formName: attributionEventsTable.formName,
      createdAt: attributionEventsTable.createdAt,
    })
    .from(attributionEventsTable)
    .where(and(
      eq(attributionEventsTable.tenantId, tenantId),
      gte(attributionEventsTable.createdAt, lookbackDate),
    ))
    .orderBy(desc(attributionEventsTable.createdAt))
    .limit(maxEvents);

  const leadIds = new Set<number>();
  let scanned = 0;
  let hitLimit = false;
  for (const ev of events) {
    scanned++;
    if (!ev.createdLeadId) continue;
    if (excludeLeadId && ev.createdLeadId === excludeLeadId) continue;
    if (leadIds.has(ev.createdLeadId)) continue;

    const evPath = extractPagePath(ev.pageUrl);
    if (evPath !== pageUrlPattern) continue;

    const evFormIdent = getFormIdentifier(ev.formId, ev.formName);
    if (formIdentifier !== "*" && evFormIdent !== formIdentifier) continue;

    leadIds.add(ev.createdLeadId);
    if (leadIds.size >= maxLeads) {
      hitLimit = true;
      break;
    }
  }

  let leadsChanged = 0;
  for (const leadId of leadIds) {
    try {
      const result = await reDeriveLeadFunnel(tenantId, leadId);
      if (result?.changed) leadsChanged++;
    } catch (err) {
      console.error("[reDeriveLeadsForRuleScope] reDeriveLeadFunnel failed for lead", leadId, err);
    }
  }

  return {
    scanned,
    leadsConsidered: leadIds.size,
    leadsChanged,
    hitLimit,
    maxLeads,
  };
}

export interface PendingRederiveCount {
  pendingLeads: number;
  hitLimit: boolean;
  maxLeads: number;
  lastAttemptedAt: string;
}

export interface PendingRederiveLeadSummary {
  id: number;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  funnelId: number | null;
  leadType: string | null;
  serviceType: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PendingRederiveLeadList {
  leads: PendingRederiveLeadSummary[];
  hitLimit: boolean;
  maxLeads: number;
}

// Shared helper: walk recent attribution events for `tenantId` and collect the
// set of lead ids whose most-recent submission matches the
// (pageUrlPattern, formIdentifier) scope. Returns the lead-id set, whether the
// `maxLeads` cap was hit, and the rule-update cutoff used to define "pending"
// (a lead's `updatedAt` must predate this for it to count). Both
// `countPendingRederiveLeadsForRuleScope` and
// `listPendingRederiveLeadsForRuleScope` use this so a single change to the
// scope-matching logic stays in sync between the count hint and the
// "View pending leads" sheet that operators open from the failure hint.
async function collectPendingRederiveScope(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
  options: { lookbackDays?: number; maxEvents?: number; maxLeads?: number; excludeLeadId?: number | null } = {},
): Promise<{ leadIds: Set<number>; hitLimit: boolean; maxLeads: number; cutoff: Date | null }> {
  const lookbackDays = options.lookbackDays ?? 30;
  const maxEvents = options.maxEvents ?? 2000;
  const maxLeads = options.maxLeads ?? 200;
  const excludeLeadId = options.excludeLeadId ?? null;

  const [latestRule] = await db
    .select({ updatedAt: fieldMappingRulesTable.updatedAt })
    .from(fieldMappingRulesTable)
    .where(and(
      eq(fieldMappingRulesTable.tenantId, tenantId),
      eq(fieldMappingRulesTable.pageUrlPattern, pageUrlPattern),
      eq(fieldMappingRulesTable.formIdentifier, formIdentifier),
    ))
    .orderBy(desc(fieldMappingRulesTable.updatedAt))
    .limit(1);
  const cutoff: Date | null = latestRule?.updatedAt ?? null;

  const lookbackDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const events = await db
    .select({
      createdLeadId: attributionEventsTable.createdLeadId,
      pageUrl: attributionEventsTable.pageUrl,
      formId: attributionEventsTable.formId,
      formName: attributionEventsTable.formName,
    })
    .from(attributionEventsTable)
    .where(and(
      eq(attributionEventsTable.tenantId, tenantId),
      gte(attributionEventsTable.createdAt, lookbackDate),
    ))
    .orderBy(desc(attributionEventsTable.createdAt))
    .limit(maxEvents);

  const leadIds = new Set<number>();
  let hitLimit = false;
  for (const ev of events) {
    if (!ev.createdLeadId) continue;
    if (excludeLeadId && ev.createdLeadId === excludeLeadId) continue;
    if (leadIds.has(ev.createdLeadId)) continue;
    const evPath = extractPagePath(ev.pageUrl);
    if (evPath !== pageUrlPattern) continue;
    const evFormIdent = getFormIdentifier(ev.formId, ev.formName);
    if (formIdentifier !== "*" && evFormIdent !== formIdentifier) continue;
    leadIds.add(ev.createdLeadId);
    if (leadIds.size >= maxLeads) { hitLimit = true; break; }
  }

  return { leadIds, hitLimit, maxLeads, cutoff };
}

/**
 * Count how many historical leads in the given rule scope still need to be
 * re-derived — i.e. leads whose most-recent attribution event matches
 * (pageUrlPattern, formIdentifier) and whose `leads.updatedAt` predates the
 * latest matching field-mapping rule's `createdAt`. Used to populate the
 * "~N historical leads still need updating" hint that the operator UI shows
 * next to a failed-rederive notice, so they can size up whether retrying now
 * is cheap or expensive.
 *
 * Mirrors the lookback / event-cap / lead-cap bounds of
 * `reDeriveLeadsForRuleScope` so the count reflects the same population the
 * fan-out would actually touch on a retry.
 */
export async function countPendingRederiveLeadsForRuleScope(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
  options: { lookbackDays?: number; maxEvents?: number; maxLeads?: number; excludeLeadId?: number | null } = {},
): Promise<PendingRederiveCount> {
  const lastAttemptedAt = new Date().toISOString();
  const { leadIds, hitLimit, maxLeads, cutoff } = await collectPendingRederiveScope(
    tenantId, pageUrlPattern, formIdentifier, options,
  );

  if (leadIds.size === 0) {
    return { pendingLeads: 0, hitLimit, maxLeads, lastAttemptedAt };
  }

  const conditions = [
    eq(leadsTable.tenantId, tenantId),
    inArray(leadsTable.id, Array.from(leadIds)),
  ];
  if (cutoff) conditions.push(lt(leadsTable.updatedAt, cutoff));
  const rows = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(and(...conditions));

  return {
    pendingLeads: rows.length,
    hitLimit,
    maxLeads,
    lastAttemptedAt,
  };
}

/**
 * Return the actual list of historical leads still pending a re-derive for the
 * given rule scope, with the same lookback / event-cap / lead-cap bounds as
 * `reDeriveLeadsForRuleScope` and `countPendingRederiveLeadsForRuleScope`. The
 * operator UI opens this from the "View pending leads" link on the
 * re-derive-failure hint so they can drill in and investigate (or fix
 * individual leads by hand) rather than just seeing a count.
 *
 * Each row includes the minimum fields the sheet/list needs to render: name,
 * contact info, current funnel, and timestamps. Sorted newest-first by
 * `createdAt` so the most recently-affected leads surface at the top.
 */
export async function listPendingRederiveLeadsForRuleScope(
  tenantId: number,
  pageUrlPattern: string,
  formIdentifier: string,
  options: { lookbackDays?: number; maxEvents?: number; maxLeads?: number; excludeLeadId?: number | null } = {},
): Promise<PendingRederiveLeadList> {
  const { leadIds, hitLimit, maxLeads, cutoff } = await collectPendingRederiveScope(
    tenantId, pageUrlPattern, formIdentifier, options,
  );

  if (leadIds.size === 0) {
    return { leads: [], hitLimit, maxLeads };
  }

  const conditions = [
    eq(leadsTable.tenantId, tenantId),
    inArray(leadsTable.id, Array.from(leadIds)),
  ];
  if (cutoff) conditions.push(lt(leadsTable.updatedAt, cutoff));

  const rows = await db
    .select({
      id: leadsTable.id,
      firstName: leadsTable.firstName,
      lastName: leadsTable.lastName,
      phone: leadsTable.phone,
      email: leadsTable.email,
      funnelId: leadsTable.funnelId,
      leadType: leadsTable.leadType,
      serviceType: leadsTable.serviceType,
      createdAt: leadsTable.createdAt,
      updatedAt: leadsTable.updatedAt,
    })
    .from(leadsTable)
    .where(and(...conditions));

  // Sort newest-first in JS — the result set is capped by `maxLeads` (200 by
  // default) so the cost is negligible, and this keeps the drizzle chain
  // simple (matches the shape `countPendingRederiveLeadsForRuleScope` uses).
  const leads = [...rows].sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
  );

  return { leads, hitLimit, maxLeads };
}
