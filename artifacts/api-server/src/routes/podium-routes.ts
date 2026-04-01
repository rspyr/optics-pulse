import { Router, type IRouter } from "express";
import { db, leadsTable, callAttemptsTable, podiumMessagesTable, usersTable } from "@workspace/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { searchContactByPhone, getContactConversations, getConversationMessages, sendMessage, ensurePodiumContact } from "../services/integrations/podium-api";
import { emitPodiumMessage } from "../socket";

const router: IRouter = Router();

function resolveTenantId(req: { query?: Record<string, string>; body?: Record<string, unknown>; session?: Record<string, unknown> }): number | null {
  const session = req.session as Record<string, unknown> | undefined;
  const role = session?.userRole as string | undefined;
  if (role === "super_admin" || role === "agency_user") {
    const queryTid = req.query?.tenantId;
    const bodyTid = (req.body as Record<string, unknown>)?.tenantId;
    return queryTid ? Number(queryTid) : bodyTid ? Number(bodyTid) : (session?.tenantId as number) ?? null;
  }
  return (session?.tenantId as number) ?? null;
}

type PodiumMessageRow = typeof podiumMessagesTable.$inferSelect;

async function syncPodiumMessagesForLead(userId: number, tenantId: number, leadId: number, phone: string): Promise<PodiumMessageRow[]> {
  try {
    const contact = await searchContactByPhone(userId, phone);
    if (contact) {
      const conversations = await getContactConversations(userId, contact.uid);
      for (const conv of conversations.slice(0, 5)) {
        const msgs = await getConversationMessages(userId, conv.uid);
        for (const msg of msgs) {
          try {
            await db.insert(podiumMessagesTable).values({
              tenantId,
              leadId,
              podiumConversationUid: conv.uid,
              podiumMessageUid: msg.uid,
              direction: msg.direction === "inbound" ? "inbound" : "outbound",
              body: msg.body,
              channelType: msg.channelType || conv.channelType,
              senderName: msg.senderName || null,
              deliveryStatus: msg.deliveryStatus || "delivered",
              podiumCreatedAt: msg.createdAt ? new Date(msg.createdAt) : new Date(),
            }).onConflictDoNothing();
          } catch {}
        }
      }
    }
  } catch (err) {
    console.warn("[Podium Sync] Error syncing from Podium API for lead", leadId, err);
  }

  return db.select().from(podiumMessagesTable)
    .where(and(eq(podiumMessagesTable.tenantId, tenantId), eq(podiumMessagesTable.leadId, leadId)))
    .orderBy(desc(podiumMessagesTable.podiumCreatedAt));
}

router.get("/podium/conversations/:leadId", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const leadId = parseInt(String(req.params.leadId));
  const [lead] = await db.select().from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  if (!lead.phone) { res.json({ messages: [] }); return; }

  try {
    const messages = await syncPodiumMessagesForLead(userId, tenantId, leadId, lead.phone);
    res.json({ messages });
  } catch (err) {
    console.error("[Podium Routes] Error fetching conversations:", err);
    res.status(500).json({ error: "Failed to fetch Podium conversations" });
  }
});

router.post("/podium/messages", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const { leadId, body: messageBody } = req.body;
  if (!leadId || !messageBody) {
    res.status(400).json({ error: "leadId and body are required" });
    return;
  }

  const [lead] = await db.select().from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  if (!lead.phone) { res.status(400).json({ error: "Lead has no phone number" }); return; }

  try {
    await ensurePodiumContact(userId, tenantId, leadId);

    const fullName = `${lead.firstName} ${lead.lastName}`.trim();
    const result = await sendMessage(userId, lead.phone, messageBody, fullName);

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

  const tenantId = resolveTenantId(req);
  if (!tenantId) { res.status(400).json({ error: "No tenant context" }); return; }

  const leadId = parseInt(String(req.params.leadId));
  const [lead] = await db.select().from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const podiumSyncPromise = lead.phone
    ? syncPodiumMessagesForLead(userId, tenantId, leadId, lead.phone)
    : Promise.resolve([]);

  const [callAttempts, podiumMessages] = await Promise.all([
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
    }).from(callAttemptsTable)
      .where(eq(callAttemptsTable.leadId, leadId))
      .orderBy(desc(callAttemptsTable.attemptedAt)),
    podiumSyncPromise,
  ]);

  const userIds = [...new Set(callAttempts.map(a => a.userId))];
  let userMap: Record<number, string> = {};
  if (userIds.length > 0) {
    const users = await db.select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable).where(inArray(usersTable.id, userIds));
    userMap = Object.fromEntries(users.map(u => [u.id, u.name]));
  }

  interface TimelineEntry {
    type: "pulse_action" | "podium_text" | "podium_call";
    source: string;
    timestamp: string;
    id: number;
    [key: string]: unknown;
  }

  const timeline: TimelineEntry[] = [];

  for (const ca of callAttempts) {
    timeline.push({
      type: "pulse_action",
      source: "pulse",
      timestamp: ca.attemptedAt.toISOString(),
      id: ca.id,
      ...ca,
      csrName: userMap[ca.userId] || "Unknown",
    });
  }

  for (const pm of podiumMessages) {
    const isPodiumCall = pm.channelType === "call" || pm.channelType === "phone_call";
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
    });
  }

  timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  res.json({ timeline });
});

export default router;
