import { db, leadsTable, attributionEventsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { detectFields } from "./field-detection";
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
