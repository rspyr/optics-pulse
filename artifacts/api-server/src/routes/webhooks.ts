import { Router, type IRouter } from "express";
import { db, attributionEventsTable, leadsTable, funnelTypesTable, tenantFunnelTypesTable } from "@workspace/db";
import { IngestWebhookBody } from "@workspace/api-zod";
import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { emitNewLead } from "../socket";
import { assignLeadRoundRobin } from "../services/round-robin";

const router: IRouter = Router();

function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\+]/g, "").replace(/^1/, "");
}

function verifySignature(payload: string, signature: string | undefined): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    return true;
  }
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function resolveFunnelType(tenantId: number, funnelSlug: string | null | undefined): Promise<{ name: string; id: number } | null> {
  if (!funnelSlug) return null;
  const [ft] = await db.select().from(funnelTypesTable)
    .where(eq(funnelTypesTable.slug, funnelSlug));
  if (!ft) return null;
  const [assoc] = await db.select().from(tenantFunnelTypesTable)
    .where(and(eq(tenantFunnelTypesTable.tenantId, tenantId), eq(tenantFunnelTypesTable.funnelTypeId, ft.id)));
  if (!assoc) return null;
  return { name: ft.name, id: ft.id };
}

router.post("/webhooks/ingest", async (req, res) => {
  try {
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody
      ? (req as typeof req & { rawBody?: Buffer }).rawBody!.toString("utf-8")
      : JSON.stringify(req.body);
    const signature = req.headers["x-mos-signature"] as string | undefined;

    const body = IngestWebhookBody.parse(req.body);

    const pausedSources = ["callrail", "ghl", "podium"];
    if (pausedSources.includes(body.source)) {
      res.json({ success: false, eventId: 0, message: `${body.source} integration is currently paused` });
      return;
    }

    if (!verifySignature(rawBody, signature)) {
      res.status(401).json({ success: false, eventId: 0, message: "Invalid webhook signature" });
      return;
    }

    const { source, tenantId, data } = body;

    const hashedPhone = data.phone ? hashValue(normalizePhone(data.phone)) : null;
    const hashedEmail = data.email ? hashValue(data.email) : null;

    let eventType: "click" | "call" | "form_fill" = "form_fill";
    if (source === "callrail") eventType = "call";
    else if (source === "manual") eventType = "click";

    const externalId = source === "callrail" && data.externalId
      ? `callrail:${data.externalId}`
      : data.externalId || null;

    const [event] = await db.insert(attributionEventsTable).values({
      tenantId,
      eventType,
      gclid: data.gclid || null,
      hashedPhone,
      hashedEmail,
      utmSource: data.utmSource || null,
      utmCampaign: data.utmCampaign || null,
      utmMedium: data.utmMedium || null,
      landingPage: data.landingPage || null,
      matchLevel: data.gclid ? "diamond" : hashedPhone ? "golden" : hashedEmail ? "silver" : "unmatched",
      matchConfidence: data.gclid ? 1.0 : hashedPhone ? 0.9 : hashedEmail ? 0.8 : 0,
      externalId,
    }).returning();

    const webhookNameFields = [data.firstName, data.lastName].filter(Boolean).join(" ").toLowerCase();
    const isTestLead = webhookNameFields.includes("test");

    if (!isTestLead && (data.firstName || data.lastName || data.phone || data.email)) {
      const rawBody = req.body as Record<string, unknown>;
      const rawData = (rawBody.data || {}) as Record<string, unknown>;
      const funnelSlug = data.funnel || (rawData._mos_funnel as string) || null;
      const resolved = await resolveFunnelType(tenantId, funnelSlug);
      const resolvedLeadType = resolved?.name || source;
      const resolvedFunnelId = resolved?.id || null;
      const [newLead] = await db.insert(leadsTable).values({
        tenantId,
        firstName: data.firstName || "Unknown",
        lastName: data.lastName || "",
        phone: data.phone || null,
        email: data.email || null,
        source: data.utmSource || source,
        matchedGclid: data.gclid || null,
        interestType: null,
        leadType: resolvedLeadType,
        funnelId: resolvedFunnelId,
        hubStatus: "day_1",
        dayInSequence: 1,
        status: "new",
      }).returning();

      if (newLead) {
        try {
          const result = await assignLeadRoundRobin(tenantId, newLead.id, resolvedFunnelId);
          if (!result.assignedCsrId) {
            console.warn(`[Webhook] Lead ${newLead.id} not assigned: ${result.reason}`);
          }
        } catch (err) {
          console.warn("[Webhook] Auto-assign round-robin failed for lead", newLead.id, err);
        }
        const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, newLead.id));
        emitNewLead(tenantId, (refreshed ?? newLead) as unknown as Record<string, unknown>);
      }
    }

    res.json({ success: true, eventId: event.id, message: `Webhook from ${source} processed successfully` });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to process webhook";
    res.status(400).json({ success: false, eventId: 0, message });
  }
});

router.post("/webhooks/ghl", async (_req, res) => {
  res.json({ success: false, message: "GHL integration is currently paused" });
});

router.post("/webhooks/podium", async (_req, res): Promise<void> => {
  res.json({ success: false, message: "Podium integration is currently paused" });
});

export default router;
