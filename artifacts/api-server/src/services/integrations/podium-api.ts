import { getValidPodiumToken } from "./podium-auth";
import { db, leadsTable, tenantsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { decryptConfig } from "../../lib/encryption";

const PODIUM_API = "https://api.podium.com/v4";
const PODIUM_VERSION = "2024-04-01";

async function podiumFetch(tenantId: number, path: string, options: RequestInit = {}): Promise<Response> {
  const token = await getValidPodiumToken(tenantId);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "podium-version": PODIUM_VERSION,
    ...(options.headers as Record<string, string> || {}),
  };
  return fetch(`${PODIUM_API}${path}`, { ...options, headers });
}

async function getLocationUid(tenantId: number): Promise<string> {
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) throw new Error("Tenant not found");
  let config: Record<string, unknown> = {};
  if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
    try { config = decryptConfig(tenant.apiConfig); } catch {}
  }
  const uid = config.podiumLocationUid as string;
  if (!uid) throw new Error("Podium location not configured for this tenant");
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

export async function searchContactByPhone(tenantId: number, phone: string): Promise<PodiumContact | null> {
  const cleanPhone = phone.replace(/[^0-9+]/g, "");
  const res = await podiumFetch(tenantId, `/contacts?phoneNumber=${encodeURIComponent(cleanPhone)}`);
  if (!res.ok) {
    console.error(`[Podium API] searchContactByPhone failed: ${res.status}`);
    return null;
  }
  const data = await res.json() as { data?: PodiumContact[] };
  return data.data && data.data.length > 0 ? data.data[0] : null;
}

export async function getConversationMessages(tenantId: number, conversationUid: string): Promise<PodiumConversationMessage[]> {
  const res = await podiumFetch(tenantId, `/conversations/${conversationUid}/messages`);
  if (!res.ok) {
    console.error(`[Podium API] getConversationMessages failed: ${res.status}`);
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
}

export async function getContactConversations(tenantId: number, contactUid: string): Promise<Array<{ uid: string; channelType: string }>> {
  const res = await podiumFetch(tenantId, `/contacts/${contactUid}/conversations`);
  if (!res.ok) {
    console.error(`[Podium API] getContactConversations failed: ${res.status}`);
    return [];
  }
  const data = await res.json() as { data?: Array<{ uid: string; channelType?: string }> };
  return (data.data || []).map(c => ({ uid: c.uid, channelType: c.channelType || "sms" }));
}

export async function sendMessage(tenantId: number, phone: string, body: string, contactName?: string): Promise<{ success: boolean; messageUid?: string; conversationUid?: string }> {
  const locationUid = await getLocationUid(tenantId);
  const cleanPhone = phone.replace(/[^0-9+]/g, "");

  const payload: Record<string, unknown> = {
    locationUid,
    channelType: "phone",
    message: body,
    phoneNumber: cleanPhone,
  };
  if (contactName) {
    payload.contactName = contactName;
  }

  const res = await podiumFetch(tenantId, "/conversations", {
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
}

export async function createContact(tenantId: number, name: string, phone: string, email?: string): Promise<PodiumContact | null> {
  const locationUid = await getLocationUid(tenantId);
  const cleanPhone = phone.replace(/[^0-9+]/g, "");

  const nameParts = name.split(" ");
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || "";

  const payload: Record<string, unknown> = {
    locationUid,
    firstName,
    lastName,
    phoneNumbers: [{ number: cleanPhone, type: "cell" }],
  };
  if (email) {
    payload.emails = [{ address: email, type: "personal" }];
  }

  const res = await podiumFetch(tenantId, "/contacts", {
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
}

export async function updateContact(tenantId: number, contactUid: string, name: string, phone: string, email?: string): Promise<PodiumContact | null> {
  const nameParts = name.split(" ");
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || "";
  const cleanPhone = phone.replace(/[^0-9+]/g, "");

  const payload: Record<string, unknown> = {
    firstName,
    lastName,
    phoneNumbers: [{ number: cleanPhone, type: "cell" }],
  };
  if (email) {
    payload.emails = [{ address: email, type: "personal" }];
  }

  const res = await podiumFetch(tenantId, `/contacts/${contactUid}`, {
    method: "PUT",
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
}

export async function ensurePodiumContact(tenantId: number, leadId: number): Promise<string | null> {
  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, tenantId)));
  if (!lead) return null;

  if (lead.podiumContactUid) {
    return lead.podiumContactUid;
  }

  if (!lead.phone) return null;

  const fullName = `${lead.firstName} ${lead.lastName}`.trim();

  const existing = await searchContactByPhone(tenantId, lead.phone);

  if (existing) {
    await db.update(leadsTable)
      .set({ podiumContactUid: existing.uid, updatedAt: new Date() })
      .where(eq(leadsTable.id, leadId));

    const existingName = `${existing.firstName || ""} ${existing.lastName || ""}`.trim();
    if (existingName !== fullName || (lead.email && !existing.emails?.some(e => e.address === lead.email))) {
      try {
        await updateContact(tenantId, existing.uid, fullName, lead.phone, lead.email || undefined);
      } catch (err) {
        console.warn(`[Podium] Failed to update contact for lead ${leadId}:`, err);
      }
    }

    console.log(`[Podium] Linked existing contact ${existing.uid} to lead ${leadId}`);
    return existing.uid;
  }

  const newContact = await createContact(tenantId, fullName, lead.phone, lead.email || undefined);
  if (newContact) {
    await db.update(leadsTable)
      .set({ podiumContactUid: newContact.uid, updatedAt: new Date() })
      .where(eq(leadsTable.id, leadId));
    console.log(`[Podium] Created new contact ${newContact.uid} for lead ${leadId}`);
    return newContact.uid;
  }

  return null;
}
