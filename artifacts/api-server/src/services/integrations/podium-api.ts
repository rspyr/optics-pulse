import { getValidPodiumToken, getPodiumConfig, isPodiumConnected } from "./podium-auth";
import { db, leadsTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const PODIUM_API = "https://api.podium.com/v4";
const PODIUM_VERSION = "2024-04-01";

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
    "podium-version": PODIUM_VERSION,
    ...(options.headers as Record<string, string> || {}),
  };
  return fetch(`${PODIUM_API}${path}`, { ...options, headers });
}

async function getLocationUid(userId: number): Promise<string> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) throw new Error("User not found");
  const config = getPodiumConfig(user);
  const uid = config.podiumLocationUid as string;
  if (!uid) throw new Error("Podium location not configured for this user");
  return uid;
}

export interface PodiumContact {
  uid: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  phoneNumbers?: Array<{ number: string; type?: string }>;
  emails?: Array<{ address: string; type?: string }>;
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
}

export async function searchContactByPhone(userId: number, phone: string): Promise<PodiumContact | null> {
  const cleanPhone = toE164(phone);
  try {
    const locationUid = await getLocationUid(userId);
    const res = await podiumFetch(userId, `/contacts?phoneNumber=${encodeURIComponent(cleanPhone)}&locationUid=${encodeURIComponent(locationUid)}`);
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Podium API] searchContactByPhone failed (${res.status}): ${errText}`);
      return null;
    }
    const data = await res.json() as { data?: PodiumContact[] };
    return data.data && data.data.length > 0 ? data.data[0] : null;
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
    const data = await res.json() as { data?: PodiumConversationMessage[] };
    return (data.data || []).map(m => ({
      uid: m.uid,
      body: m.body || "",
      direction: m.direction || "outbound",
      channelType: m.channelType || "sms",
      senderName: m.senderName,
      deliveryStatus: m.deliveryStatus,
      createdAt: m.createdAt,
      conversationUid,
    }));
  } catch (err) {
    if (err instanceof PodiumNotConnectedError) return [];
    throw err;
  }
}

export async function getContactConversations(userId: number, contactUid: string): Promise<Array<{ uid: string; channelType: string }>> {
  try {
    const res = await podiumFetch(userId, `/contacts/${contactUid}/conversations`);
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Podium API] getContactConversations failed (${res.status}): ${errText}`);
      return [];
    }
    const data = await res.json() as { data?: Array<{ uid: string; channelType?: string }> };
    return (data.data || []).map(c => ({ uid: c.uid, channelType: c.channelType || "sms" }));
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
      locationUid,
      channelIdentifier: cleanPhone,
      body,
    };
    if (contactName) {
      payload.customerName = contactName;
    }

    const res = await podiumFetch(userId, "/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Podium API] sendMessage failed (${res.status}): ${errText}`);
      return { success: false };
    }

    const data = await res.json() as { data?: { uid?: string; messages?: Array<{ uid: string }> } };
    return {
      success: true,
      conversationUid: data.data?.uid,
      messageUid: data.data?.messages?.[0]?.uid,
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

    const nameParts = name.split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    const payload: Record<string, unknown> = {
      locationUid,
      firstName,
      lastName,
      phoneNumbers: [{ number: cleanPhone, numberType: "mobile" }],
    };
    if (email) {
      payload.emailAddresses = [{ address: email, addressType: "personal" }];
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

export async function updateContact(userId: number, contactUid: string, name: string, phone: string, email?: string): Promise<PodiumContact | null> {
  try {
    const nameParts = name.split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";
    const cleanPhone = toE164(phone);

    const payload: Record<string, unknown> = {
      firstName,
      lastName,
      phoneNumbers: [{ number: cleanPhone, numberType: "mobile" }],
    };
    if (email) {
      payload.emailAddresses = [{ address: email, addressType: "personal" }];
    }

    const res = await podiumFetch(userId, `/contacts/${contactUid}`, {
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
    const res = await podiumFetch(userId, "/users");
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
    const res = await podiumFetch(userId, `/conversations/${conversationUid}/assignees`);
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Podium API] getConversationAssignees failed (${res.status}): ${errText}`);
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

export async function assignConversation(userId: number, conversationUid: string, assigneeUids: string[]): Promise<boolean> {
  try {
    const res = await podiumFetch(userId, `/conversations/${conversationUid}/assignees`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeUids }),
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

    const existingName = `${existing.firstName || ""} ${existing.lastName || ""}`.trim();
    if (existingName !== fullName || (lead.email && !existing.emails?.some(e => e.address === lead.email))) {
      try {
        await updateContact(userId, existing.uid, fullName, lead.phone, lead.email || undefined);
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
