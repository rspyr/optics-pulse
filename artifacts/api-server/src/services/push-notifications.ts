import { db, pushTokensTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import webpush from "web-push";

const vapidPublic = process.env.VAPID_PUBLIC_KEY;
const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || "mailto:admin@marketingos.app";

if (vapidPublic && vapidPrivate) {
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  console.log("[Push] VAPID keys configured for web push");
} else {
  console.warn("[Push] VAPID keys not configured — web push disabled");
}

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

async function sendWebPushToUser(
  userId: number,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (!vapidPublic || !vapidPrivate) return;

  const webTokens = await db.select().from(pushTokensTable)
    .where(eq(pushTokensTable.userId, userId));

  const webSubs = webTokens.filter(t => t.platform === "web" && t.subscription);
  if (webSubs.length === 0) return;

  console.log(`[Push] Sending web push "${title}" to user ${userId} (${webSubs.length} sub(s))`);

  for (const sub of webSubs) {
    try {
      const payload = JSON.stringify({ title, body, url: "/pulse", ...data });
      await webpush.sendNotification(sub.subscription as webpush.PushSubscription, payload);
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await db.delete(pushTokensTable).where(eq(pushTokensTable.id, sub.id));
        console.log(`[Push] Removed expired web subscription for user ${userId}`);
      } else {
        console.error(`[Push] Web push error for user ${userId}:`, err);
      }
    }
  }
}

export async function sendPushToUser(
  userId: number,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    const tokens = await db.select().from(pushTokensTable).where(eq(pushTokensTable.userId, userId));
    if (tokens.length === 0) {
      console.log(`[Push] No tokens registered for user ${userId}, skipping`);
      return;
    }

    const expoTokens = tokens.filter(t => t.platform !== "web");
    const hasWebTokens = tokens.some(t => t.platform === "web");

    if (expoTokens.length > 0) {
      console.log(`[Push] Sending "${title}" to user ${userId} (${expoTokens.length} expo token(s))`);

      const messages: ExpoPushMessage[] = expoTokens.map(t => ({
        to: t.token,
        title,
        body,
        data,
        sound: "default",
      }));

      const tickets = await sendExpoPush(messages);

      let okCount = 0;
      let errCount = 0;
      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === "ok") {
          okCount++;
        } else if (ticket.status === "error") {
          errCount++;
          console.error(`[Push] Ticket error for user ${userId}: ${ticket.details?.error ?? ticket.message ?? "unknown"}`);
          if (ticket.details?.error === "DeviceNotRegistered") {
            const tokenToRemove = expoTokens[i]?.token;
            if (tokenToRemove) {
              await db.delete(pushTokensTable).where(eq(pushTokensTable.token, tokenToRemove));
              console.log(`[Push] Removed invalid token for user ${userId}`);
            }
          }
        }
      }
      console.log(`[Push] Delivery result for user ${userId}: ${okCount} ok, ${errCount} error(s)`);
    }

    if (hasWebTokens) {
      await sendWebPushToUser(userId, title, body, data);
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
