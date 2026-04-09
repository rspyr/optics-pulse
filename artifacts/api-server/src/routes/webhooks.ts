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
import { normalizeAddress } from "../services/reconciliation";
import { webhookLimiter } from "../middleware/rate-limit";

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

function extractWebhookBillingAddress(dataObj: Record<string, unknown>): string | null {
  const street = typeof dataObj.address === "string" ? dataObj.address.trim()
    : typeof dataObj.street === "string" ? dataObj.street.trim()
    : typeof dataObj.street_address === "string" ? dataObj.street_address.trim()
    : typeof dataObj.streetAddress === "string" ? dataObj.streetAddress.trim()
    : null;
  const city = typeof dataObj.city === "string" ? dataObj.city.trim() : null;
  const state = typeof dataObj.state === "string" ? dataObj.state.trim()
    : typeof dataObj.province === "string" ? dataObj.province.trim()
    : null;
  const zip = typeof dataObj.zip === "string" ? dataObj.zip.trim()
    : typeof dataObj.zipcode === "string" ? dataObj.zipcode.trim()
    : typeof dataObj.zip_code === "string" ? dataObj.zip_code.trim()
    : typeof dataObj.postal_code === "string" ? dataObj.postal_code.trim()
    : typeof dataObj.postalCode === "string" ? dataObj.postalCode.trim()
    : null;

  if (!street && !city) return null;

  const addressParts: string[] = [];
  if (street) addressParts.push(street);
  if (city) addressParts.push(city);
  if (state && zip) {
    addressParts.push(`${state} ${zip}`);
  } else if (state) {
    addressParts.push(state);
  } else if (zip) {
    addressParts.push(zip);
  }

  return normalizeAddress(addressParts.join(", "));
}

router.post("/webhooks/ingest", webhookLimiter, async (req, res) => {
  try {
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody
      ? (req as typeof req & { rawBody?: Buffer }).rawBody!.toString("utf-8")
      : JSON.stringify(req.body);
    const signature = req.headers["x-mos-signature"] as string | undefined;

    const body = IngestWebhookBody.parse(req.body);

    const pausedSources: string[] = [];
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

    const rawExternalId = (req.body as Record<string, unknown>).data
      ? ((req.body as Record<string, unknown>).data as Record<string, unknown>).externalId as string | undefined
      : undefined;
    const externalId = source === "callrail" && rawExternalId
      ? `callrail:${rawExternalId}`
      : rawExternalId || null;

    const bodyObj = req.body as Record<string, unknown>;
    const dataObj = (bodyObj.data || {}) as Record<string, unknown>;
    const billingAddress = extractWebhookBillingAddress(dataObj);
    const wbraid = (dataObj.wbraid as string) || null;
    const fbclid = (dataObj.fbclid as string) || null;
    const msclkid = (dataObj.msclkid as string) || null;
    const ttclid = (dataObj.ttclid as string) || null;
    const liFatId = (dataObj.liFatId as string) || (dataObj.li_fat_id as string) || null;
    const utmTerm = (dataObj.utmTerm as string) || (dataObj.utm_term as string) || null;
    const utmContent = (dataObj.utmContent as string) || (dataObj.utm_content as string) || null;
    const pageUrl = (dataObj.pageUrl as string) || (dataObj.page_url as string) || null;
    const referrer = (dataObj.referrer as string) || null;
    const userAgent = (dataObj.userAgent as string) || (dataObj.user_agent as string) || null;
    const formType = (dataObj.formType as string) || (dataObj.form_type as string) || null;
    const formId = (dataObj.formId as string) || (dataObj.form_id as string) || null;
    const formName = (dataObj.formName as string) || (dataObj.form_name as string) || null;
    const formFields = (dataObj.formFields as Record<string, unknown>) || (dataObj.form_fields as Record<string, unknown>) || null;

    const [event] = await db.insert(attributionEventsTable).values({
      tenantId,
      eventType,
      gclid: data.gclid || null,
      wbraid,
      fbclid,
      msclkid,
      ttclid,
      liFatId,
      hashedPhone,
      hashedEmail,
      billingAddress,
      utmSource: data.utmSource || null,
      utmCampaign: data.utmCampaign || null,
      utmMedium: data.utmMedium || null,
      utmTerm,
      utmContent,
      landingPage: data.landingPage || null,
      pageUrl,
      referrer,
      userAgent,
      formType,
      formId,
      formName,
      formFields,
      matchLevel: data.gclid ? "diamond" : hashedPhone ? "golden" : hashedEmail ? "silver" : "unmatched",
      matchConfidence: data.gclid ? 1.0 : hashedPhone ? 0.9 : hashedEmail ? 0.8 : 0,
      externalId,
    }).returning();

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

router.post("/webhooks/ghl", webhookLimiter, async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody
      ? (req as typeof req & { rawBody?: Buffer }).rawBody!.toString("utf-8")
      : JSON.stringify(req.body);
    const signature = req.headers["x-mos-signature"] as string | undefined;
    if (!verifySignature(rawBody, signature)) {
      res.status(401).json({ success: false, message: "Invalid webhook signature" });
      return;
    }

    const contact = (body.contact || body) as Record<string, unknown>;
    const customData = (body.customData || body.custom_data || {}) as Record<string, unknown>;

    const tenantIdRaw = body.tenantId || body.tenant_id || customData.tenantId || customData.tenant_id;
    if (!tenantIdRaw || isNaN(Number(tenantIdRaw))) {
      res.status(400).json({ success: false, message: "Missing or invalid tenantId" });
      return;
    }
    const tenantId = Number(tenantIdRaw);

    const phone = String(contact.phone || contact.phone_number || "").trim() || null;
    const email = String(contact.email || "").trim() || null;
    const firstName = String(contact.firstName || contact.first_name || contact.name || "").trim() || null;
    const lastName = String(contact.lastName || contact.last_name || "").trim() || null;
    const fullName = String(contact.fullName || contact.full_name || "").trim() || null;

    const hashedPhone = phone ? hashValue(normalizePhone(phone)) : null;
    const hashedEmail = email ? hashValue(email) : null;

    const gclid = String(customData.gclid || body.gclid || "").trim() || null;
    const fbclid = String(customData.fbclid || body.fbclid || "").trim() || null;
    const wbraid = String(customData.wbraid || body.wbraid || "").trim() || null;
    const utmSource = String(customData.utmSource || customData.utm_source || body.utm_source || "ghl").trim();
    const utmCampaign = String(customData.utmCampaign || customData.utm_campaign || body.utm_campaign || "").trim() || null;
    const utmMedium = String(customData.utmMedium || customData.utm_medium || body.utm_medium || "").trim() || null;
    const utmTerm = String(customData.utmTerm || customData.utm_term || body.utm_term || "").trim() || null;
    const utmContent = String(customData.utmContent || customData.utm_content || body.utm_content || "").trim() || null;
    const landingPage = String(customData.landingPage || customData.landing_page || body.landing_page || "").trim() || null;
    const pageUrl = String(customData.pageUrl || customData.page_url || body.page_url || "").trim() || null;
    const referrer = String(customData.referrer || body.referrer || "").trim() || null;

    const formObj = (body.form || {}) as Record<string, unknown>;
    const formId = String(formObj.id || body.formId || body.form_id || "").trim() || null;
    const formName = String(formObj.name || body.formName || body.form_name || "").trim() || null;
    const formType = String(body.type || body.eventType || body.event_type || "form_fill").trim() || null;

    const formFields = (body.fields || body.formFields || body.form_fields || null) as Record<string, unknown> | null;

    const externalId = contact.id ? `ghl:${String(contact.id)}` : null;

    const [event] = await db.insert(attributionEventsTable).values({
      tenantId,
      eventType: "form_fill",
      gclid,
      wbraid,
      fbclid,
      hashedPhone,
      hashedEmail,
      utmSource,
      utmCampaign,
      utmMedium,
      utmTerm,
      utmContent,
      landingPage,
      pageUrl,
      referrer,
      formType,
      formId,
      formName,
      formFields,
      externalId,
      matchLevel: gclid ? "diamond" : hashedPhone ? "golden" : hashedEmail ? "silver" : "unmatched",
      matchConfidence: gclid ? 1.0 : hashedPhone ? 0.9 : hashedEmail ? 0.8 : 0,
    }).returning();

    const webhookNameFields = [firstName, lastName, fullName].filter(Boolean).join(" ").toLowerCase();
    const isTestLead = webhookNameFields.includes("test");

    if (!isTestLead && (firstName || lastName || phone || email)) {
      const funnelSlug = (customData.funnel as string) || (customData._mos_funnel as string) || null;
      const resolved = await resolveFunnelType(tenantId, funnelSlug);
      const resolvedLeadType = resolved?.name || "ghl";
      const resolvedFunnelId = resolved?.id || null;
      const rawApptDate = (customData.appointmentDate as string) || (contact.appointmentDate as string) || null;
      const rawApptTime = (customData.appointmentTime as string) || (contact.appointmentTime as string) || null;
      const hasApptDetails = isValidAppointmentValue(rawApptDate) || isValidAppointmentValue(rawApptTime);

      const [newLead] = await db.insert(leadsTable).values({
        tenantId,
        firstName: firstName || "Unknown",
        lastName: lastName || "",
        phone: phone || null,
        email: email || null,
        source: await normalizeSource(tenantId, utmSource || "ghl"),
        matchedGclid: gclid || null,
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
            console.warn(`[GHL Webhook] Lead ${newLead.id} not assigned: ${result.reason}`);
          }
        } catch (err) {
          console.warn("[GHL Webhook] Auto-assign round-robin failed for lead", newLead.id, err);
        }
        const [refreshed] = await db.select().from(leadsTable).where(eq(leadsTable.id, newLead.id));
        emitNewLead(tenantId, (refreshed ?? newLead) as unknown as Record<string, unknown>);
      }
    }

    console.log(`[GHL Webhook] Processed event ${event.id} for tenant ${tenantId}`);
    res.json({ success: true, eventId: event.id, message: "GHL webhook processed successfully" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to process GHL webhook";
    console.error("[GHL Webhook] Error:", error);
    res.status(400).json({ success: false, eventId: 0, message });
  }
});

function verifyPodiumSignature(rawBody: Buffer | string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

router.post("/webhooks/podium", webhookLimiter, async (req, res): Promise<void> => {
  try {
    const podiumSignature = req.headers["x-podium-signature"] as string | undefined;
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const body = req.body as Record<string, unknown>;

    const metadata = body.metadata as Record<string, unknown> | undefined;
    const eventType = String(metadata?.eventType || body.eventType || body.event_type || "");
    const data = (body.data || body) as Record<string, unknown>;

    const validEvents = ["message.sent", "message.received", "message.failed"];
    if (!validEvents.includes(eventType)) {
      res.json({ success: true, message: "Event type ignored" });
      return;
    }

    const conversation = data.conversation as Record<string, unknown> | undefined;
    const channel = conversation?.channel as Record<string, unknown> | undefined;
    const location = data.location as Record<string, unknown> | undefined;
    const contact = data.contact as Record<string, unknown> | undefined;

    const messageUid = String(data.uid || data.messageUid || "");
    const conversationUid = String(conversation?.uid || data.conversationUid || data.conversation_uid || "");
    const messageBody = String(data.body || data.text || "");
    const direction = eventType === "message.received" ? "inbound" : "outbound";
    const channelType = String(channel?.type || data.channelType || data.channel_type || "sms");
    const senderName = String(contact?.name || data.senderName || data.sender_name || "");
    const deliveryStatus = eventType === "message.failed" ? "failed" : (String(data.deliveryStatus || data.delivery_status || "delivered"));
    const podiumCreatedAt = data.createdAt ? new Date(String(data.createdAt)) : new Date();
    const phoneIdentifier = String(channel?.identifier || data.phoneNumber || data.phone_number || "");
    const locationUid = String(location?.uid || data.locationUid || data.location_uid || "");
    const messageItems = data.items as unknown[] | undefined;

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
              let hmacOk = false;
              if (!podiumSignature || !rawBody) {
                console.debug(`[Podium Webhook] Missing signature or raw body for HMAC-configured user ${user.id}, falling back to verify-token check`);
                if (config.podiumWebhookVerifyToken) {
                  const verifyToken = req.query.verify as string | undefined;
                  if (verifyToken && verifyToken === config.podiumWebhookVerifyToken) {
                    hmacOk = true;
                  } else {
                    console.warn(`[Podium Webhook] Verify token fallback also failed for user ${user.id}`);
                    continue;
                  }
                } else {
                  continue;
                }
              } else {
                const sig = podiumSignature.startsWith("sha256=") ? podiumSignature.slice(7) : podiumSignature;
                if (verifyPodiumSignature(rawBody, sig, config.podiumWebhookSecret as string)) {
                  hmacOk = true;
                } else {
                  console.warn(`[Podium Webhook] HMAC signature mismatch for user ${user.id}`);
                  continue;
                }
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
        } catch (err) {
          console.warn(`[Podium Webhook] Error decrypting podiumConfig for user ${user.id}:`, err);
        }
      }

      if (!matchedTenantId) {
        const allTenants = await db.select({ id: tenantsTable.id, apiConfig: tenantsTable.apiConfig }).from(tenantsTable);
        for (const t of allTenants) {
          if (t.apiConfig && typeof t.apiConfig === "object") {
            const cfg = t.apiConfig as Record<string, unknown>;
            if (cfg.podiumLocationId === locationUid) {
              matchedTenantId = t.id;
              console.log(`[Podium Webhook] Matched location ${locationUid} to tenant ${t.id} via tenant api_config fallback`);
              break;
            }
          }
        }
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
      messageItems: messageItems || null,
      podiumCreatedAt,
    }).returning();

    let leadName: string | null = null;
    let assignedCsrId: number | null = null;
    if (matchedLeadId) {
      const [lead] = await db.select({ firstName: leadsTable.firstName, lastName: leadsTable.lastName, assignedCsrId: leadsTable.assignedCsrId })
        .from(leadsTable).where(eq(leadsTable.id, matchedLeadId)).limit(1);
      if (lead) {
        leadName = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || null;
        assignedCsrId = lead.assignedCsrId;
      }
    }

    const { emitPodiumMessage } = await import("../socket");
    emitPodiumMessage(matchedTenantId, {
      ...inserted,
      eventType,
      leadName: leadName || senderName || null,
    } as unknown as Record<string, unknown>);

    if (direction === "inbound" && matchedTenantId) {
      const { sendPushToUser, sendPushToTenantUsers } = await import("../services/push-notifications");
      const isCall = channelType === "phone" || channelType === "call" || channelType === "phone_call" || channelType === "car_wars";
      const pushTitle = isCall ? "Incoming Call" : "Inbound Text";
      const contactName = leadName || senderName || "Unknown Contact";
      const pushBody = isCall
        ? `${contactName} is calling`
        : `${contactName}: ${messageBody.slice(0, 100) || "(no message)"}`;
      const pushData = { leadId: matchedLeadId, type: "podium_inbound", channelType };
      if (assignedCsrId) {
        sendPushToUser(assignedCsrId, pushTitle, pushBody, pushData)
          .catch(err => console.error("[Podium Webhook] Push notification error:", err));
      } else {
        sendPushToTenantUsers(matchedTenantId, pushTitle, pushBody, pushData)
          .catch(err => console.error("[Podium Webhook] Push notification error:", err));
      }
    }

    console.log(`[Podium Webhook] ${eventType} — message ${messageUid} stored for tenant ${matchedTenantId}, lead ${matchedLeadId}`);
    res.json({ success: true, message: "Webhook processed" });
  } catch (error) {
    console.error("[Podium Webhook] Error:", error);
    res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
});

export default router;
