import { Router, type IRouter } from "express";
import { db, attributionEventsTable, leadsTable, tenantsTable, funnelTypesTable } from "@workspace/db";
import { IngestWebhookBody } from "@workspace/api-zod";
import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { emitNewLead } from "../socket";
import { verifyCallRailSignature } from "../services/integrations/callrail";
import { parseGHLWebhookPayload } from "../services/integrations/ghl";
import { parsePodiumWebhookPayload } from "../services/integrations/podium";
import { decryptConfig } from "../lib/encryption";
import { reviewsTable } from "@workspace/db";

const router: IRouter = Router();

function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\+]/g, "").replace(/^1/, "");
}

function verifySignature(payload: string, signature: string | undefined): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (process.env.NODE_ENV === "development" && !secret) {
    return true;
  }
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function resolveFunnelType(tenantId: number, funnelSlug: string | null | undefined): Promise<string | null> {
  if (!funnelSlug) return null;
  const [ft] = await db.select().from(funnelTypesTable)
    .where(and(eq(funnelTypesTable.tenantId, tenantId), eq(funnelTypesTable.slug, funnelSlug)));
  return ft ? ft.name : funnelSlug;
}

async function getCallRailSigningKey(tenantId: number): Promise<string | undefined> {
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant?.apiConfig || typeof tenant.apiConfig !== "string") return undefined;
  try {
    const config = decryptConfig(tenant.apiConfig) as Record<string, string>;
    return config.callRailSigningKey;
  } catch {
    return undefined;
  }
}

router.post("/webhooks/ingest", async (req, res) => {
  try {
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody
      ? (req as typeof req & { rawBody?: Buffer }).rawBody!.toString("utf-8")
      : JSON.stringify(req.body);
    const signature = req.headers["x-mos-signature"] as string | undefined;
    const callrailSignature = req.headers["x-callrail-signature"] as string | undefined;

    const body = IngestWebhookBody.parse(req.body);

    if (body.source === "callrail") {
      const signingKey = await getCallRailSigningKey(body.tenantId);
      if (!verifyCallRailSignature(rawBody, callrailSignature, signingKey)) {
        res.status(401).json({ success: false, eventId: 0, message: "Invalid CallRail webhook signature" });
        return;
      }
    } else if (!verifySignature(rawBody, signature)) {
      res.status(401).json({ success: false, eventId: 0, message: "Invalid webhook signature" });
      return;
    }

    const { source, tenantId, data } = body;

    const hashedPhone = data.phone ? hashValue(normalizePhone(data.phone)) : null;
    const hashedEmail = data.email ? hashValue(data.email) : null;

    let eventType: "click" | "call" | "form_fill" = "form_fill";
    if (source === "callrail") eventType = "call";
    else if (source === "manual") eventType = "click";

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
    }).returning();

    if (data.firstName || data.lastName || data.phone || data.email) {
      const rawBody = req.body as Record<string, unknown>;
      const rawData = (rawBody.data || {}) as Record<string, unknown>;
      const funnelSlug = data.funnel || (rawData._mos_funnel as string) || null;
      const resolvedLeadType = await resolveFunnelType(tenantId, funnelSlug) || source;
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
      }).returning();

      if (newLead) {
        emitNewLead(tenantId, newLead as unknown as Record<string, unknown>);
      }
    }

    res.json({ success: true, eventId: event.id, message: `Webhook from ${source} processed successfully` });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to process webhook";
    res.status(400).json({ success: false, eventId: 0, message });
  }
});

router.post("/webhooks/ghl", async (req, res) => {
  try {
    const tenantId = req.body.tenantId ? Number(req.body.tenantId) : (req.query.tenantId ? Number(req.query.tenantId) : null);
    if (!tenantId) {
      res.status(400).json({ success: false, message: "tenantId is required" });
      return;
    }

    const parsed = parseGHLWebhookPayload(req.body);
    const hashedPhone = parsed.phone ? hashValue(normalizePhone(parsed.phone)) : null;
    const hashedEmail = parsed.email ? hashValue(parsed.email) : null;

    const [event] = await db.insert(attributionEventsTable).values({
      tenantId,
      eventType: "form_fill",
      gclid: parsed.gclid || null,
      hashedPhone,
      hashedEmail,
      utmSource: parsed.utmSource || "ghl",
      utmCampaign: parsed.utmCampaign || null,
      utmMedium: parsed.utmMedium || null,
      landingPage: parsed.landingPage || null,
      matchLevel: parsed.gclid ? "diamond" : hashedPhone ? "golden" : hashedEmail ? "silver" : "unmatched",
      matchConfidence: parsed.gclid ? 1.0 : hashedPhone ? 0.9 : hashedEmail ? 0.8 : 0,
    }).returning();

    const ghlFunnelSlug = (parsed as Record<string, unknown>).funnelSlug as string | undefined;
    const ghlLeadType = await resolveFunnelType(tenantId, ghlFunnelSlug) || "ghl";
    const [newLead] = await db.insert(leadsTable).values({
      tenantId,
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      phone: parsed.phone || null,
      email: parsed.email || null,
      source: "ghl",
      matchedGclid: parsed.gclid || null,
      leadType: ghlLeadType,
    }).returning();

    if (newLead) {
      emitNewLead(tenantId, newLead as unknown as Record<string, unknown>);
    }

    res.json({ success: true, eventId: event.id, leadId: newLead?.id });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to process GHL webhook";
    res.status(400).json({ success: false, message });
  }
});

router.post("/webhooks/podium", async (req, res): Promise<void> => {
  try {
    const tenantId = Number(req.query.tenantId || req.body.tenantId);
    if (!tenantId) { res.status(400).json({ success: false, message: "tenantId required" }); return; }

    const parsed = parsePodiumWebhookPayload(req.body);
    if (!parsed) { res.status(400).json({ success: false, message: "Invalid payload" }); return; }

    const existing = await db.select().from(reviewsTable)
      .where(eq(reviewsTable.tenantId, tenantId));

    const alreadyExists = existing.some(r => r.externalId === parsed.externalId);
    if (!alreadyExists) {
      const sentiment = parsed.rating >= 4 ? "positive" : parsed.rating <= 2 ? "negative" : "neutral";
      await db.insert(reviewsTable).values({
        tenantId,
        platform: "podium",
        externalId: parsed.externalId,
        reviewerName: parsed.reviewerName,
        rating: parsed.rating,
        body: parsed.reviewBody,
        sentiment,
        reviewDate: parsed.reviewDate,
      });
    }

    res.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to process Podium webhook";
    res.status(400).json({ success: false, message });
  }
});

export default router;
