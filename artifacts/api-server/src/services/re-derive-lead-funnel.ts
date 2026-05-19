import { db, leadsTable, attributionEventsTable } from "@workspace/db";
import { eq, and, desc, gte } from "drizzle-orm";
import { detectFields, extractPagePath, getFormIdentifier } from "./field-detection";
import { normalizeFunnel } from "./funnel-normalizer";

export interface RederiveResult {
  changed: boolean;
  leadId: number;
  funnelId: number | null;
  leadType: string | null;
  serviceType: string | null;
}

/**
 * Re-run field detection and funnel normalization for a single lead using its
 * most recent attribution event's form fields, and persist any change to
 * leads.funnelId / leads.leadType / leads.serviceType. Returns the updated
 * denormalized columns and a `changed` flag so callers can decide whether to
 * surface a refreshed lead.
 */
export async function reDeriveLeadFunnel(
  tenantId: number,
  leadId: number,
): Promise<RederiveResult | null> {
  const [lead] = await db.select().from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) return null;

  const [event] = await db.select()
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

  if (event && event.formFields && typeof event.formFields === "object") {
    const detection = await detectFields(
      tenantId,
      event.formFields as Record<string, unknown>,
      event.pageUrl ?? null,
      event.formId ?? null,
      event.formName ?? null,
    );
    if (detection.funnelRawValue) {
      nextServiceType = detection.funnelRawValue;
      const match = await normalizeFunnel(tenantId, detection.funnelRawValue);
      if (match) {
        nextFunnelId = match.funnelTypeId;
        nextLeadType = match.funnelName;
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
