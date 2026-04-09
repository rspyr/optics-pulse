import { getValidPodiumToken, getPodiumConfig, isPodiumConnected } from "./podium-auth";
import { db, leadsTable, usersTable, tenantsTable, podiumMessagesTable } from "@workspace/db";
import { eq, and, desc as descOrder, sql } from "drizzle-orm";
import { decryptConfig, encryptConfig } from "../../lib/encryption";

const PODIUM_API = "https://api.podium.com/v4";

class PodiumNotConnectedError extends Error {
  constructor() { super("Podium is not connected for this user"); this.name = "PodiumNotConnectedError"; }
}

export function toE164(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (phone.startsWith("+") && digits.length >= 11) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return `+${digits}`;
}

async function podiumFetch(userId: number, path: string, options: RequestInit = {}): Promise<Response> {
  const connected = await isPodiumConnected(userId);
  if (!connected) {
    throw new PodiumNotConnectedError();
  }
  const token = await getValidPodiumToken(userId);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(options.headers as Record<string, string> || {}),
  };
  return fetch(`${PODIUM_API}${path}`, { ...options, headers });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

async function getLocationUid(userId: number): Promise<string> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) throw new Error("User not found");

  const config = getPodiumConfig(user);
  const userLocationUid = config.podiumLocationUid as string | undefined;
  if (userLocationUid) {
    if (isValidUuid(userLocationUid)) {
      return userLocationUid;
    }
    console.warn(`[Podium API] User ${userId} has non-UUID podiumLocationUid "${userLocationUid}", falling through to resolve`);
  }

  if (user.tenantId) {
    const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId));
    if (tenant?.apiConfig && typeof tenant.apiConfig === "object") {
      const tenantConfig = tenant.apiConfig as Record<string, unknown>;
      const tenantLocationId = tenantConfig.podiumLocationId as string | undefined;
      if (tenantLocationId) {
        if (isValidUuid(tenantLocationId)) {
          config.podiumLocationUid = tenantLocationId;
          await db.update(usersTable)
            .set({ podiumConfig: encryptConfig(config) as unknown as string, updatedAt: new Date() })
            .where(eq(usersTable.id, userId));
          return tenantLocationId;
        }
        console.warn(`[Podium API] Tenant ${user.tenantId} has non-UUID podiumLocationId "${tenantLocationId}", falling through to live fetch`);
      }
    }
  }

  try {
    const token = await getValidPodiumToken(userId);
    const locResponse = await fetch(`${PODIUM_API}/locations?limit=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (locResponse.ok) {
      const locData = await locResponse.json() as { data?: Array<{ uid: string; name?: string }> };
      if (locData.data && locData.data.length > 0) {
        const fetchedUid = locData.data[0].uid;
        config.podiumLocationUid = fetchedUid;
        config.podiumLocationName = locData.data[0].name || "Unknown Location";
        await db.update(usersTable)
          .set({ podiumConfig: encryptConfig(config) as unknown as string, updatedAt: new Date() })
          .where(eq(usersTable.id, userId));
        console.log(`[Podium API] Resolved location UID via live fetch: ${fetchedUid}`);
        return fetchedUid;
      }
    }
  } catch (err) {
    console.warn("[Podium API] Live location fetch failed:", err);
  }

  throw new Error("Podium location not configured for this user");
}

export interface PodiumContactChannel {
  label?: string;
  type: string;
  identifier: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PodiumContact {
  uid: string;
  name?: string;
  phoneNumbers?: string[];
  emails?: string[];
  channels?: PodiumContactChannel[];
  conversations?: Array<{ uid: string }>;
  locations?: Array<{ uid: string }>;
}

export interface PodiumConversationMessage {
  uid: string;
  body: string;
  direction: string;
  channelType: string;
  senderName?: string;
  deliveryStatus?: string;
  createdAt: string;
  conversationUid: string;
  items?: unknown[];
}

export async function searchContactByPhone(userId: number, phone: string): Promise<PodiumContact | null> {
  const cleanPhone = toE164(phone);
  try {
    const res = await podiumFetch(userId, `/contacts/${encodeURIComponent(cleanPhone)}`);
    if (!res.ok) {
      if (res.status === 404) return null;
      const errText = await res.text();
      console.error(`[Podium API] searchContactByPhone failed (${res.status}): ${errText}`);
      return null;
    }
    const data = await res.json() as { data?: PodiumContact };
    return data.data || null;
  } catch (err) {
    if (err instanceof PodiumNotConnectedError) return null;
    throw err;
  }
}

export async function getConversationMessages(userId: number, conversationUid: string): Promise<PodiumConversationMessage[]> {
  try {
    const res = await podiumFetch(userId, `/conversations/${conversationUid}/messages`);
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Podium API] getConversationMessages failed (${res.status}): ${errText}`);
      return [];
    }
    const rawData = await res.json() as { data?: Array<Record<string, unknown>> };
    return (rawData.data || []).map(m => ({
      uid: String(m.uid || ""),
      body: String(m.body || ""),
      direction: String(m.sourceType || m.direction || "outbound"),
      channelType: String(((m.conversation as Record<string, unknown>)?.channel as Record<string, unknown> | undefined)?.type || m.channelType || "sms"),
      senderName: m.senderName as string | undefined,
      deliveryStatus: m.deliveryStatus as string | undefined,
      createdAt: String(m.createdAt || ""),
      conversationUid,
      items: m.items as unknown[] | undefined,
    }));
  } catch (err) {
    if (err instanceof PodiumNotConnectedError) return [];
    throw err;
  }
}

export async function getContactConversations(userId: number, phone: string): Promise<Array<{ uid: string; channelType: string }>> {
  try {
    const contact = await searchContactByPhone(userId, phone);
    if (contact?.conversations && contact.conversations.length > 0) {
      const results: Array<{ uid: string; channelType: string }> = [];
      for (const c of contact.conversations) {
        try {
          const convRes = await podiumFetch(userId, `/conversations/${c.uid}`);
          if (convRes.ok) {
            const convData = await convRes.json() as { data?: { channel?: { type?: string } } };
            results.push({ uid: c.uid, channelType: convData.data?.channel?.type || "sms" });
          } else {
            results.push({ uid: c.uid, channelType: "sms" });
          }
        } catch {
          results.push({ uid: c.uid, channelType: "sms" });
        }
      }
      return results;
    }

    const locationUid = await getLocationUid(userId);
    const res = await podiumFetch(userId, `/conversations?locationUid=${encodeURIComponent(locationUid)}&limit=100`);
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Podium API] getContactConversations failed (${res.status}): ${errText}`);
      return [];
    }
    const data = await res.json() as { data?: Array<{ uid: string; channel?: { type?: string; identifier?: string } }> };
    const cleanPhone = toE164(phone);
    const phoneSuffix = cleanPhone.replace(/^\+1?/, "");
    return (data.data || [])
      .filter(c => {
        const id = c.channel?.identifier || "";
        return id.includes(phoneSuffix) || id === cleanPhone;
      })
      .map(c => ({ uid: c.uid, channelType: c.channel?.type || "sms" }));
  } catch (err) {
    if (err instanceof PodiumNotConnectedError) return [];
    throw err;
  }
}

export async function sendMessage(userId: number, phone: string, body: string, contactName?: string): Promise<{ success: boolean; messageUid?: string; conversationUid?: string }> {
  try {
    const locationUid = await getLocationUid(userId);
    const cleanPhone = toE164(phone);

    const payload: Record<string, unknown> = {
      body,
      channel: {
        type: "phone",
        identifier: cleanPhone,
      },
      locationUid,
    };
    if (contactName) {
      payload.contactName = contactName;
    }

    const res = await podiumFetch(userId, "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Podium API] sendMessage failed (${res.status}): ${errText}`);
      return { success: false };
    }

    const data = await res.json() as { data?: { uid?: string; conversationUid?: string; conversation?: { uid?: string } } };
    return {
      success: true,
      messageUid: data.data?.uid,
      conversationUid: data.data?.conversationUid || data.data?.conversation?.uid,
    };
  } catch (err) {
    if (err instanceof PodiumNotConnectedError) return { success: false };
    throw err;
  }
}

export async function createContact(userId: number, name: string, phone: string, email?: string): Promise<PodiumContact | null> {
  try {
    const locationUid = await getLocationUid(userId);
    const cleanPhone = toE164(phone);

    const payload: Record<string, unknown> = {
      name,
      phoneNumber: cleanPhone,
      locations: [{ uid: locationUid }],
    };
    if (email) {
      payload.email = email;
    }

    const res = await podiumFetch(userId, "/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Podium API] createContact failed (${res.status}): ${errText}`);
      return null;
    }

    const data = await res.json() as { data?: PodiumContact };
    return data.data || null;
  } catch (err) {
    if (err instanceof PodiumNotConnectedError) return null;
    throw err;
  }
}

export async function updateContact(userId: number, phone: string, name: string, email?: string): Promise<PodiumContact | null> {
  try {
    const cleanPhone = toE164(phone);
    const locationUid = await getLocationUid(userId).catch(() => null);

    const payload: Record<string, unknown> = {
      name,
      phoneNumber: cleanPhone,
    };
    if (email) {
      payload.email = email;
    }
    if (locationUid) {
      payload.locations = [{ uid: locationUid }];
    }

    const res = await podiumFetch(userId, `/contacts/${encodeURIComponent(cleanPhone)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Podium API] updateContact failed (${res.status}): ${errText}`);
      return null;
    }

    const data = await res.json() as { data?: PodiumContact };
    return data.data || null;
  } catch (err) {
    if (err instanceof PodiumNotConnectedError) return null;
    throw err;
  }
}

export interface PodiumUser {
  uid: string;
  email?: string;
  name?: string;
  role?: string;
}

export async function getPodiumUsers(userId: number): Promise<PodiumUser[]> {
  try {
    const res = await podiumFetch(userId, "/users?limit=100&includeAgents=false");
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Podium API] getPodiumUsers failed (${res.status}): ${errText}`);
      return [];
    }
    const data = await res.json() as { data?: Array<{ uid: string; email?: string; firstName?: string; lastName?: string; role?: string }> };
    return (data.data || []).map(u => ({
      uid: u.uid,
      email: u.email,
      name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.uid,
      role: u.role,
    }));
  } catch (err) {
    if (err instanceof PodiumNotConnectedError) return [];
    throw err;
  }
}

export async function getConversationAssignees(userId: number, conversationUid: string): Promise<PodiumUser[]> {
  try {
    const res = await podiumFetch(userId, `/conversations/${conversationUid}`);
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Podium API] getConversationAssignees failed (${res.status}): ${errText}`);
      return [];
    }
    const data = await res.json() as { data?: { assignedUserId?: string; assignedUser?: { uid?: string; name?: string } } };
    const conv = data.data;
    if (!conv) return [];
    const assignedUid = conv.assignedUserId || conv.assignedUser?.uid;
    if (!assignedUid) return [];
    return [{
      uid: assignedUid,
      name: conv.assignedUser?.name || undefined,
    }];
  } catch (err) {
    if (err instanceof PodiumNotConnectedError) return [];
    throw err;
  }
}

export async function assignConversation(userId: number, conversationUid: string, assigneeUids: string[], options?: { keepAiAssignment?: boolean; name?: string }): Promise<boolean> {
  try {
    const payload: Record<string, unknown> = { assigneeUids };
    if (options?.keepAiAssignment !== undefined) {
      payload.keepAiAssignment = options.keepAiAssignment;
    }
    if (options?.name) {
      payload.name = options.name;
    }

    const res = await podiumFetch(userId, `/conversations/${conversationUid}/assignees`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Podium API] assignConversation failed (${res.status}): ${errText}`);
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof PodiumNotConnectedError) return false;
    throw err;
  }
}

export async function syncPodiumConversationAssignment(leadId: number, targetCsrId: number): Promise<void> {
  try {
    const [targetUser] = await db.select({
      id: usersTable.id,
      podiumUserUid: usersTable.podiumUserUid,
      tenantId: usersTable.tenantId,
    }).from(usersTable).where(eq(usersTable.id, targetCsrId));

    if (!targetUser?.podiumUserUid) {
      console.log(`[Podium Sync] CSR ${targetCsrId} has no linked Podium account — skipping assignment for lead ${leadId}`);
      return;
    }

    if (!targetUser.tenantId) {
      console.log(`[Podium Sync] CSR ${targetCsrId} has no tenant — skipping assignment for lead ${leadId}`);
      return;
    }

    const [latestMsg] = await db.select({ podiumConversationUid: podiumMessagesTable.podiumConversationUid })
      .from(podiumMessagesTable)
      .where(and(
        sql`${podiumMessagesTable.leadId} = ${leadId}`,
        eq(podiumMessagesTable.tenantId, targetUser.tenantId),
      ))
      .orderBy(descOrder(podiumMessagesTable.podiumCreatedAt), descOrder(podiumMessagesTable.createdAt))
      .limit(1);

    if (!latestMsg?.podiumConversationUid) {
      console.log(`[Podium Sync] No Podium conversation found for lead ${leadId} — skipping`);
      return;
    }

    const connectedUsers = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.tenantId, targetUser.tenantId));

    let apiUserId: number | null = null;
    for (const u of connectedUsers) {
      if (await isPodiumConnected(u.id)) {
        apiUserId = u.id;
        break;
      }
    }

    if (!apiUserId) {
      console.log(`[Podium Sync] No Podium-connected user in tenant ${targetUser.tenantId} — skipping assignment for lead ${leadId}`);
      return;
    }

    const success = await assignConversation(apiUserId, latestMsg.podiumConversationUid, [targetUser.podiumUserUid]);
    if (success) {
      console.log(`[Podium Sync] Reassigned conversation ${latestMsg.podiumConversationUid} to Podium user ${targetUser.podiumUserUid} (CSR ${targetCsrId}) for lead ${leadId}`);
    } else {
      console.warn(`[Podium Sync] Failed to reassign conversation ${latestMsg.podiumConversationUid} for lead ${leadId}`);
    }
  } catch (err) {
    console.error(`[Podium Sync] Error syncing assignment for lead ${leadId}:`, err);
  }
}

export async function ensurePodiumContact(userId: number, tenantId: number, leadId: number): Promise<string | null> {
  const connected = await isPodiumConnected(userId);
  if (!connected) return null;

  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) return null;

  if (lead.podiumContactUid) {
    return lead.podiumContactUid;
  }

  if (!lead.phone) return null;

  const fullName = `${lead.firstName} ${lead.lastName}`.trim();

  const existing = await searchContactByPhone(userId, lead.phone);

  if (existing) {
    await db.update(leadsTable)
      .set({ podiumContactUid: existing.uid, updatedAt: new Date() })
      .where(eq(leadsTable.id, leadId));

    const existingName = (existing.name || "").trim();
    if (existingName !== fullName || (lead.email && !existing.emails?.includes(lead.email))) {
      try {
        await updateContact(userId, lead.phone, fullName, lead.email || undefined);
      } catch (err) {
        console.warn(`[Podium] Failed to update contact for lead ${leadId}:`, err);
      }
    }

    console.log(`[Podium] Linked existing contact ${existing.uid} to lead ${leadId}`);
    return existing.uid;
  }

  const newContact = await createContact(userId, fullName, lead.phone, lead.email || undefined);
  if (newContact) {
    await db.update(leadsTable)
      .set({ podiumContactUid: newContact.uid, updatedAt: new Date() })
      .where(eq(leadsTable.id, leadId));
    console.log(`[Podium] Created new contact ${newContact.uid} for lead ${leadId}`);
    return newContact.uid;
  }

  return null;
}
