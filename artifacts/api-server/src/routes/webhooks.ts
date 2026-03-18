import { Router, type IRouter } from "express";
import { db, attributionEventsTable, leadsTable } from "@workspace/db";
import { IngestWebhookBody } from "@workspace/api-zod";
import crypto from "crypto";
import { emitNewLead } from "../socket";

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

router.post("/webhooks/ingest", async (req, res) => {
  try {
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody
      ? (req as typeof req & { rawBody?: Buffer }).rawBody!.toString("utf-8")
      : JSON.stringify(req.body);
    const signature = req.headers["x-mos-signature"] as string | undefined;

    if (!verifySignature(rawBody, signature)) {
      res.status(401).json({ success: false, eventId: 0, message: "Invalid webhook signature" });
      return;
    }

    const body = IngestWebhookBody.parse(req.body);
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
      const [newLead] = await db.insert(leadsTable).values({
        tenantId,
        firstName: data.firstName || "Unknown",
        lastName: data.lastName || "",
        phone: data.phone || null,
        email: data.email || null,
        source: data.utmSource || source,
        matchedGclid: data.gclid || null,
        interestType: null,
        leadType: source,
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

export default router;
