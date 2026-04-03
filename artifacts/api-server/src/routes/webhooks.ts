import { Router, type IRouter } from "express";
import { db, attributionEventsTable, leadsTable, funnelTypesTable, tenantFunnelTypesTable, tenantsTable, usersTable, callAttemptsTable } from "@workspace/db";
import { IngestWebhookBody } from "@workspace/api-zod";
import crypto from "crypto";
import { eq, and, sql, isNotNull } from "drizzle-orm";
import { emitNewLead } from "../socket";
import { assignLeadRoundRobin } from "../services/round-robin";
import { scheduleAutoPass } from "../services/auto-pass-scheduler";
import { isValidAppointmentValue } from "../utils/appointment-validation";
import { normalizeSource } from "../services/source-normalizer";

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

    const bodyObj = req.body as Record<string, unknown>;
    const dataObj = (bodyObj.data || {}) as Record<string, unknown>;
    const rawFullName = typeof dataObj.fullName === "string" ? dataObj.fullName : "";
    const webhookNameFields = [data.firstName, data.lastName, rawFullName].filter(Boolean).join(" ").toLowerCase();
    const isTestLead = webhookNameFields.includes("test");

    if (!isTestLead && (data.firstName || data.lastName || data.phone || data.email)) {
      const funnelSlug = data.funnel || (dataObj._mos_funnel as string) || null;
      const resolved = await resolveFunnelType(tenantId, funnelSlug);
      const resolvedLeadType = resolved?.name || source;
      const resolvedFunnelId = resolved?.id || null;
      const rawApptDate = (dataObj.appointmentDate as string) || null;
      const rawApptTime = (dataObj.appointmentTime as string) || null;
      const hasApptDetails = isValidAppointmentValue(rawApptDate) || isValidAppointmentValue(rawApptTime);

      const [newLead] = await db.insert(leadsTable).values({
        tenantId,
        firstName: data.firstName || "Unknown",
        lastName: data.lastName || "",
        phone: data.phone || null,
        email: data.email || null,
        source: await normalizeSource(tenantId, data.utmSource || source),
        matchedGclid: data.gclid || null,
        interestType: null,
        leadType: resolvedLeadType,
        funnelId: resolvedFunnelId,
        appointmentDate: rawApptDate,
        appointmentTime: rawApptTime,
        hubStatus: hasApptDetails ? "appt_booked" : "day_1",
        preBooked: hasApptDetails,
        dayInSequence: 1,
        status: "new",
      }).returning();

      if (newLead) {
        try {
          const result = await assignLeadRoundRobin(tenantId, newLead.id, resolvedFunnelId);
          if (result.assignedCsrId && result.passIntervalMinutes != null) {
            scheduleAutoPass(newLead.id, result.passIntervalMinutes * 60 * 1000);

            await db.insert(callAttemptsTable).values({
              leadId: newLead.id,
              userId: result.assignedCsrId,
              method: "system",
              outcome: "initial_assignment",
              platform: "native",
              actionType: "system",
              notes: `System: Lead initially assigned to ${result.csrName}`,
            });
          } else if (!result.assignedCsrId) {
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

function verifyPodiumSignature(rawBody: Buffer | string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

router.post("/webhooks/podium", async (req, res): Promise<void> => {
  try {
    const podiumSignature = req.headers["x-podium-signature"] as string | undefined;
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const body = req.body as Record<string, unknown>;
    const eventType = body.eventType as string || body.event_type as string || "";
    const data = (body.data || body) as Record<string, unknown>;

    const validEvents = ["message.sent", "message.received", "message.failed"];
    if (!validEvents.includes(eventType)) {
      res.json({ success: true, message: "Event type ignored" });
      return;
    }

    const messageUid = String(data.uid || data.messageUid || "");
    const conversationUid = String(data.conversationUid || data.conversation_uid || "");
    const messageBody = String(data.body || data.text || "");
    const direction = eventType === "message.received" ? "inbound" : "outbound";
    const channelType = String(data.channelType || data.channel_type || "sms");
    const senderName = String(data.senderName || data.sender_name || "");
    const deliveryStatus = eventType === "message.failed" ? "failed" : (String(data.deliveryStatus || data.delivery_status || "delivered"));
    const podiumCreatedAt = data.createdAt ? new Date(String(data.createdAt)) : new Date();

    const conversation = data.conversation as Record<string, unknown> | undefined;
    const channel = conversation?.channel as Record<string, unknown> | undefined;
    const phoneIdentifier = String(channel?.identifier || data.phoneNumber || data.phone_number || "");

    const locationUid = String(data.locationUid || data.location_uid || conversation?.locationUid || "");

    if (!messageUid || !conversationUid) {
      res.json({ success: false, message: "Missing message or conversation UID" });
      return;
    }

    let matchedTenantId: number | null = null;
    let matchedLeadId: number | null = null;

    if (locationUid) {
      const { decryptConfig } = await import("../lib/encryption");
      const users = await db.select().from(usersTable).where(isNotNull(usersTable.podiumConfig));
      for (const user of users) {
        if (!user.podiumConfig || typeof user.podiumConfig !== "string") continue;
        try {
          const config = decryptConfig(user.podiumConfig);
          if (config.podiumLocationUid === locationUid) {
            if (config.podiumWebhookSecret) {
              if (!podiumSignature || !rawBody) {
                console.warn(`[Podium Webhook] Missing signature or raw body for HMAC-configured user ${user.id}`);
                continue;
              }
              const sig = podiumSignature.startsWith("sha256=") ? podiumSignature.slice(7) : podiumSignature;
              if (!verifyPodiumSignature(rawBody, sig, config.podiumWebhookSecret as string)) {
                console.warn(`[Podium Webhook] HMAC signature mismatch for user ${user.id}`);
                continue;
              }
            } else if (config.podiumWebhookVerifyToken) {
              const verifyToken = req.query.verify as string | undefined;
              if (!verifyToken || verifyToken !== config.podiumWebhookVerifyToken) {
                console.warn(`[Podium Webhook] Verify token missing or mismatch for user ${user.id}`);
                continue;
              }
            }
            matchedTenantId = user.tenantId;
            break;
          }
        } catch {}
      }
    }

    if (!matchedTenantId) {
      console.warn("[Podium Webhook] Could not match user/tenant for location:", locationUid);
      res.json({ success: true, message: "No matching tenant" });
      return;
    }

    if (phoneIdentifier) {
      const cleanPhone = phoneIdentifier.replace(/[^0-9]/g, "");
      if (cleanPhone.length >= 7) {
        const leads = await db.select({ id: leadsTable.id })
          .from(leadsTable)
          .where(and(
            eq(leadsTable.tenantId, matchedTenantId),
            sql`REGEXP_REPLACE(${leadsTable.phone}, '[^0-9]', '', 'g') LIKE '%' || ${cleanPhone.slice(-10)}`
          ))
          .limit(1);
        if (leads.length > 0) {
          matchedLeadId = leads[0].id;
        }
      }
    }

    const { podiumMessagesTable } = await import("@workspace/db");

    const existing = await db.select({ id: podiumMessagesTable.id })
      .from(podiumMessagesTable)
      .where(and(
        eq(podiumMessagesTable.tenantId, matchedTenantId),
        eq(podiumMessagesTable.podiumMessageUid, messageUid),
      ))
      .limit(1);

    if (existing.length > 0) {
      if (eventType === "message.failed") {
        await db.update(podiumMessagesTable)
          .set({ deliveryStatus: "failed" })
          .where(eq(podiumMessagesTable.id, existing[0].id));
      }
      res.json({ success: true, message: "Message already stored" });
      return;
    }

    const [inserted] = await db.insert(podiumMessagesTable).values({
      tenantId: matchedTenantId,
      leadId: matchedLeadId,
      podiumConversationUid: conversationUid,
      podiumMessageUid: messageUid,
      direction,
      body: messageBody,
      channelType,
      senderName,
      deliveryStatus,
      podiumCreatedAt,
    }).returning();

    const { emitPodiumMessage } = await import("../socket");
    emitPodiumMessage(matchedTenantId, {
      ...inserted,
      eventType,
    } as unknown as Record<string, unknown>);

    console.log(`[Podium Webhook] ${eventType} — message ${messageUid} stored for tenant ${matchedTenantId}, lead ${matchedLeadId}`);
    res.json({ success: true, message: "Webhook processed" });
  } catch (error) {
    console.error("[Podium Webhook] Error:", error);
    res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
});

export default router;
