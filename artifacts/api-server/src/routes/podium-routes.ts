import { Router, type IRouter } from "express";
import { db, leadsTable, callAttemptsTable, podiumMessagesTable, usersTable, leadStatusHistoryTable } from "@workspace/db";
import { eq, and, or, desc, inArray, asc } from "drizzle-orm";
import { getContactConversations, getConversationMessages, sendMessage, ensurePodiumContact, getPodiumUsers } from "../services/integrations/podium-api";
import { isPodiumConnected } from "../services/integrations/podium-auth";
import { emitPodiumMessage } from "../socket";
import { assertResourceTenantAccess } from "../lib/tenant-scope";

const router: IRouter = Router();

function resolveTenantId(req: { query?: Record<string, unknown>; body?: unknown; session?: unknown }): number | null {
  const session = req.session as Record<string, unknown> | undefined;
  const role = session?.userRole as string | undefined;
  if (role === "super_admin" || role === "agency_user") {
    const queryTid = (req.query as Record<string, string> | undefined)?.tenantId;
    const bodyTid = (req.body as Record<string, unknown>)?.tenantId;
    return queryTid ? Number(queryTid) : bodyTid ? Number(bodyTid) : (session?.tenantId as number) ?? null;
  }
  return (session?.tenantId as number) ?? null;
}

type PodiumMessageRow = typeof podiumMessagesTable.$inferSelect;

const CALL_CHANNEL_TYPES = ["call", "phone_call", "car_wars"];

async function resolvePodiumUserId(loggedInUserId: number, tenantId: number): Promise<number | null> {
  const [loggedInUser] = await db.select({ id: usersTable.id, tenantId: usersTable.tenantId, role: usersTable.role })
    .from(usersTable).where(eq(usersTable.id, loggedInUserId));
  if (!loggedInUser) return null;

  const isCrossTenant = loggedInUser.tenantId !== tenantId;
  const isAgencyOrSuperAdmin = loggedInUser.role === "super_admin" || loggedInUser.role === "agency_user";

  if (!isCrossTenant) {
    const connected = await isPodiumConnected(loggedInUserId);
    if (connected) return loggedInUserId;
  }

  const tenantUsers = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.isActive, true)));

  for (const u of tenantUsers) {
    if (await isPodiumConnected(u.id)) return u.id;
  }

  if (isCrossTenant && isAgencyOrSuperAdmin) {
    const agencyConnected = await isPodiumConnected(loggedInUserId);
    if (agencyConnected) return loggedInUserId;
  }

  const agencyLevelUsers = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(
      eq(usersTable.isActive, true),
      or(eq(usersTable.role, "super_admin"), eq(usersTable.role, "agency_user")),
    ));
  for (const u of agencyLevelUsers) {
    if (await isPodiumConnected(u.id)) return u.id;
  }

  return null;
}

async function syncPodiumMessagesForLead(podiumUserId: number, tenantId: number, leadId: number, phone: string): Promise<PodiumMessageRow[]> {
  const connected = await isPodiumConnected(podiumUserId);
  if (!connected) {
    return [];
  }

  try {
    const conversations = await getContactConversations(podiumUserId, phone);
    for (const conv of conversations.slice(0, 5)) {
      const msgs = await getConversationMessages(podiumUserId, conv.uid);
      for (const msg of msgs) {
        try {
          await db.insert(podiumMessagesTable).values({
            tenantId,
            leadId,
            podiumConversationUid: conv.uid,
            podiumMessageUid: msg.uid,
            direction: msg.direction === "inbound" ? "inbound" : "outbound",
            body: msg.body,
            channelType: (() => {
              const raw = msg.channelType || conv.channelType;
              return raw === "phone" ? "sms" : raw;
            })(),
            senderName: msg.senderName || null,
            deliveryStatus: msg.deliveryStatus || "delivered",
            messageItems: msg.items || null,
            podiumCreatedAt: msg.createdAt ? new Date(msg.createdAt) : new Date(),
          }).onConflictDoNothing();
        } catch {}
      }
    }
  } catch (err) {
    console.warn("[Podium Sync] Error syncing from Podium API for lead", leadId, err);
  }

  return db.select().from(podiumMessagesTable)
    .where(and(eq(podiumMessagesTable.tenantId, tenantId), eq(podiumMessagesTable.leadId, leadId)))
    .orderBy(desc(podiumMessagesTable.podiumCreatedAt));
}

const PODIUM_INBOX_BASE = "https://app.podium.com/inbox/redirect-messages";

router.get("/podium/conversations/:leadId", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const leadId = parseInt(String(req.params.leadId));
  if (isNaN(leadId)) { res.status(400).json({ error: "Invalid leadId" }); return; }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const access = assertResourceTenantAccess(req, res, lead.tenantId, {
    notFoundOnMismatch: true, notFoundMessage: "Lead not found",
  });
  if (!access.ok) return;
  const tenantId = lead.tenantId;

  if (!lead.phone) { res.json({ messages: [] }); return; }

  const podiumUserId = await resolvePodiumUserId(userId, tenantId);
  if (!podiumUserId) { res.json({ messages: [], notConnected: true }); return; }

  try {
    const allMessages = await syncPodiumMessagesForLead(podiumUserId, tenantId, leadId, lead.phone);
    const messages = allMessages.filter(m => !CALL_CHANNEL_TYPES.includes(m.channelType));
    const conversationUid = messages.length > 0 ? messages[0].podiumConversationUid : null;
    const podiumDeepLink = conversationUid ? `${PODIUM_INBOX_BASE}/${conversationUid}` : null;
    res.json({ messages, conversationUid, podiumDeepLink });
  } catch (err) {
    console.error("[Podium Routes] Error fetching conversations:", err);
    res.status(500).json({ error: "Failed to fetch Podium conversations" });
  }
});

router.post("/podium/messages", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const { leadId, body: messageBody } = req.body;
  if (!leadId || !messageBody) {
    res.status(400).json({ error: "leadId and body are required" });
    return;
  }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, Number(leadId)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const access = assertResourceTenantAccess(req, res, lead.tenantId, {
    notFoundOnMismatch: true, notFoundMessage: "Lead not found",
  });
  if (!access.ok) return;
  const tenantId = lead.tenantId;

  if (!lead.phone) { res.status(400).json({ error: "Lead has no phone number" }); return; }

  const podiumUserId = await resolvePodiumUserId(userId, tenantId);
  if (!podiumUserId) { res.status(400).json({ error: "No Podium-connected user in this tenant. A team member needs to connect Podium in Settings first." }); return; }

  try {
    await ensurePodiumContact(podiumUserId, tenantId, leadId);

    const fullName = `${lead.firstName} ${lead.lastName}`.trim();
    const result = await sendMessage(podiumUserId, lead.phone, messageBody, fullName);

    if (!result.success) {
      res.status(500).json({ error: "Failed to send message via Podium" });
      return;
    }

    const [inserted] = await db.insert(podiumMessagesTable).values({
      tenantId,
      leadId,
      podiumConversationUid: result.conversationUid || "",
      podiumMessageUid: result.messageUid || `local-${Date.now()}`,
      direction: "outbound",
      body: messageBody,
      channelType: "sms",
      senderName: null,
      deliveryStatus: "sent",
      podiumCreatedAt: new Date(),
    }).returning();

    emitPodiumMessage(tenantId, inserted as unknown as Record<string, unknown>);

    res.json({ success: true, message: inserted });
  } catch (err) {
    console.error("[Podium Routes] Error sending message:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

router.get("/podium/timeline/:leadId", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const leadId = parseInt(String(req.params.leadId));
  if (isNaN(leadId)) { res.status(400).json({ error: "Invalid leadId" }); return; }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const access = assertResourceTenantAccess(req, res, lead.tenantId, {
    notFoundOnMismatch: true, notFoundMessage: "Lead not found",
  });
  if (!access.ok) return;
  const tenantId = lead.tenantId;

  const podiumUserId = lead.phone ? await resolvePodiumUserId(userId, tenantId) : null;
  const podiumSyncPromise = podiumUserId && lead.phone
    ? syncPodiumMessagesForLead(podiumUserId, tenantId, leadId, lead.phone)
    : Promise.resolve([]);

  const [callAttempts, podiumMessages, statusChanges] = await Promise.all([
    db.select({
      id: callAttemptsTable.id,
      leadId: callAttemptsTable.leadId,
      userId: callAttemptsTable.userId,
      method: callAttemptsTable.method,
      outcome: callAttemptsTable.outcome,
      platform: callAttemptsTable.platform,
      attemptedAt: callAttemptsTable.attemptedAt,
      notes: callAttemptsTable.notes,
      actionType: callAttemptsTable.actionType,
      callResult: callAttemptsTable.callResult,
      vmResult: callAttemptsTable.vmResult,
      textResult: callAttemptsTable.textResult,
      deadReason: callAttemptsTable.deadReason,
      spokeResult: callAttemptsTable.spokeResult,
      callbackAt: callAttemptsTable.callbackAt,
      appointmentDate: callAttemptsTable.appointmentDate,
      appointmentTime: callAttemptsTable.appointmentTime,
    }).from(callAttemptsTable)
      .where(eq(callAttemptsTable.leadId, leadId))
      .orderBy(desc(callAttemptsTable.attemptedAt)),
    podiumSyncPromise,
    db.select({
      id: leadStatusHistoryTable.id,
      fromStatus: leadStatusHistoryTable.fromStatus,
      toStatus: leadStatusHistoryTable.toStatus,
      changedAt: leadStatusHistoryTable.changedAt,
      changedByUserId: leadStatusHistoryTable.changedByUserId,
      reason: leadStatusHistoryTable.reason,
    }).from(leadStatusHistoryTable)
      .where(and(
        eq(leadStatusHistoryTable.leadId, leadId),
        eq(leadStatusHistoryTable.tenantId, tenantId),
      ))
      .orderBy(desc(leadStatusHistoryTable.changedAt)),
  ]);

  const userIds = [...new Set([
    ...callAttempts.map(a => a.userId),
    ...statusChanges.map(s => s.changedByUserId).filter((id): id is number => id !== null),
  ])];
  let userMap: Record<number, string> = {};
  if (userIds.length > 0) {
    const users = await db.select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable).where(inArray(usersTable.id, userIds));
    userMap = Object.fromEntries(users.map(u => [u.id, u.name]));
  }

  interface TimelineEntry {
    type: "pulse_action" | "podium_text" | "podium_call" | "status_change";
    source: string;
    timestamp: string;
    id: number;
    [key: string]: unknown;
  }

  const timeline: TimelineEntry[] = [];

  // Read per-attempt outcome detail straight from the row. Only fall
  // back to the lead-row mirror for legacy attempts written before the
  // per-attempt columns existed (those still have null spoke_result),
  // attributing the mirror to the most recent spoke_with_customer
  // attempt as a best-effort guess.
  let leadSpokeResult: "call_back" | "appointment_set" | "dead" | null = null;
  if (lead.hubStatus === "call_back") leadSpokeResult = "call_back";
  else if (lead.hubStatus === "appt_set" || lead.hubStatus === "appt_booked") leadSpokeResult = "appointment_set";
  else if (lead.hubStatus === "dead") leadSpokeResult = "dead";

  const legacyDriverId = leadSpokeResult
    ? callAttempts.find(a => a.callResult === "spoke_with_customer" && a.spokeResult === null)?.id ?? null
    : null;

  for (const ca of callAttempts) {
    const { id: caId, attemptedAt, spokeResult: caSpoke, callbackAt: caCb, appointmentDate: caAd, appointmentTime: caAt, ...caRest } = ca;
    let spokeResult: string | null = caSpoke ?? null;
    let callbackAt: string | null = caCb ? caCb.toISOString() : null;
    let appointmentDate: string | null = caAd ?? null;
    let appointmentTime: string | null = caAt ?? null;
    if (spokeResult === null && legacyDriverId !== null && caId === legacyDriverId && leadSpokeResult) {
      spokeResult = leadSpokeResult;
      if (leadSpokeResult === "call_back") {
        callbackAt = lead.callbackAt ? lead.callbackAt.toISOString() : null;
      } else if (leadSpokeResult === "appointment_set") {
        appointmentDate = lead.appointmentDate ?? null;
        appointmentTime = lead.appointmentTime ?? null;
      }
    }
    timeline.push({
      type: "pulse_action",
      source: "pulse",
      timestamp: attemptedAt.toISOString(),
      id: caId,
      ...caRest,
      csrName: userMap[ca.userId] || "Unknown",
      spokeResult,
      callbackAt,
      appointmentDate,
      appointmentTime,
    });
  }

  for (const sc of statusChanges) {
    timeline.push({
      type: "status_change",
      source: "pulse",
      timestamp: sc.changedAt.toISOString(),
      id: sc.id,
      fromStatus: sc.fromStatus,
      toStatus: sc.toStatus,
      reason: sc.reason,
      changedByUserId: sc.changedByUserId,
      csrName: sc.changedByUserId ? (userMap[sc.changedByUserId] || "Unknown") : "System",
    });
  }

  for (const pm of podiumMessages) {
    const isPodiumCall = CALL_CHANNEL_TYPES.includes(pm.channelType);
    const podiumDeepLink = pm.podiumConversationUid ? `${PODIUM_INBOX_BASE}/${pm.podiumConversationUid}` : null;
    timeline.push({
      type: isPodiumCall ? "podium_call" : "podium_text",
      source: "podium",
      timestamp: pm.podiumCreatedAt?.toISOString() || pm.createdAt.toISOString(),
      id: pm.id,
      direction: pm.direction,
      body: pm.body,
      channelType: pm.channelType,
      senderName: pm.senderName,
      deliveryStatus: pm.deliveryStatus,
      podiumMessageUid: pm.podiumMessageUid,
      podiumConversationUid: pm.podiumConversationUid,
      podiumDeepLink,
      messageItems: pm.messageItems,
    });
  }

  timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  res.json({ timeline });
});

router.get("/podium/users", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const podiumUserId = await resolvePodiumUserId(userId, tenantId);

  try {
    const podiumUsers = podiumUserId ? await getPodiumUsers(podiumUserId) : [];

    const teamMembers = await db.select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      podiumUserUid: usersTable.podiumUserUid,
    }).from(usersTable).where(and(
      eq(usersTable.tenantId, tenantId),
      eq(usersTable.isActive, true),
    ));

    const linkedMap = new Map(
      teamMembers
        .filter(m => m.podiumUserUid)
        .map(m => [m.podiumUserUid!, m])
    );

    const enriched = podiumUsers.map(pu => {
      const linked = linkedMap.get(pu.uid);
      return {
        ...pu,
        internalUserId: linked?.id ?? null,
        internalUserName: linked?.name ?? null,
      };
    });

    res.json({ podiumUsers: enriched, teamMembers, notConnected: !podiumUserId });
  } catch (err) {
    console.error("[Podium Routes] Error fetching Podium users:", err);
    res.status(500).json({ error: "Failed to fetch Podium users" });
  }
});

router.post("/podium/users/link", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const role = (req.session as unknown as Record<string, unknown>)?.userRole as string;
  if (!["super_admin", "agency_user", "client_admin"].includes(role)) {
    res.status(403).json({ error: "Only managers can link Podium users" });
    return;
  }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const { internalUserId, podiumUserUid } = req.body as { internalUserId: number; podiumUserUid: string | null };
  if (!internalUserId) { res.status(400).json({ error: "internalUserId is required" }); return; }

  try {
    const [targetUser] = await db.select().from(usersTable).where(and(
      eq(usersTable.id, internalUserId),
      eq(usersTable.tenantId, tenantId),
    ));
    if (!targetUser) { res.status(404).json({ error: "User not found" }); return; }

    if (podiumUserUid) {
      const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(and(
        eq(usersTable.podiumUserUid, podiumUserUid),
        eq(usersTable.tenantId, tenantId),
      ));
      if (existing && existing.id !== internalUserId) {
        res.status(409).json({ error: "This Podium user is already linked to another team member" });
        return;
      }
    }

    await db.update(usersTable)
      .set({ podiumUserUid: podiumUserUid || null, updatedAt: new Date() })
      .where(eq(usersTable.id, internalUserId));

    res.json({ success: true });
  } catch (err) {
    console.error("[Podium Routes] Error linking Podium user:", err);
    res.status(500).json({ error: "Failed to link Podium user" });
  }
});

export default router;
