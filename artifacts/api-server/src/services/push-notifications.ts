import { db, pushTokensTable } from "@workspace/db";
import { eq } from "drizzle-orm";

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: string;
  badge?: number;
  channelId?: string;
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

async function sendExpoPush(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
  if (messages.length === 0) return [];

  const chunks: ExpoPushMessage[][] = [];
  for (let i = 0; i < messages.length; i += 100) {
    chunks.push(messages.slice(i, i + 100));
  }

  const tickets: ExpoPushTicket[] = [];
  for (const chunk of chunks) {
    try {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk),
      });
      const result = await response.json() as { data: ExpoPushTicket[] };
      tickets.push(...(result.data || []));
    } catch (err) {
      console.error("[Push] Failed to send chunk:", err);
    }
  }

  return tickets;
}

export async function sendPushToUser(
  userId: number,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    const tokens = await db.select().from(pushTokensTable).where(eq(pushTokensTable.userId, userId));
    if (tokens.length === 0) return;

    const messages: ExpoPushMessage[] = tokens.map(t => ({
      to: t.token,
      title,
      body,
      data,
      sound: "default",
    }));

    const tickets = await sendExpoPush(messages);

    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
        const tokenToRemove = tokens[i]?.token;
        if (tokenToRemove) {
          await db.delete(pushTokensTable).where(eq(pushTokensTable.token, tokenToRemove));
          console.log(`[Push] Removed invalid token for user ${userId}`);
        }
      }
    }
  } catch (err) {
    console.error(`[Push] Error sending to user ${userId}:`, err);
  }
}

export async function sendPushToTenantUsers(
  tenantId: number,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  excludeUserId?: number,
): Promise<void> {
  try {
    const { usersTable } = await import("@workspace/db");
    const { eq: eqOp, and: andOp } = await import("drizzle-orm");

    const users = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(andOp(eqOp(usersTable.tenantId, tenantId), eqOp(usersTable.isActive, true)));

    for (const user of users) {
      if (excludeUserId && user.id === excludeUserId) continue;
      await sendPushToUser(user.id, title, body, data);
    }
  } catch (err) {
    console.error(`[Push] Error sending to tenant ${tenantId}:`, err);
  }
}
