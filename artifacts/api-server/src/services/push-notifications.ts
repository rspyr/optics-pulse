import { db, pushTokensTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import webpush from "web-push";
import apn from "@parse/node-apn";

const vapidPublic = process.env.VAPID_PUBLIC_KEY;
const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || "mailto:admin@marketingos.app";
const expoAccessToken = process.env.EXPO_ACCESS_TOKEN;

const apnsKeyId = process.env.APNS_KEY_ID;
const apnsTeamId = process.env.APNS_TEAM_ID;
const apnsBundleId = process.env.APNS_BUNDLE_ID;
const apnsKeyPath = process.env.APNS_KEY_PATH;

if (vapidPublic && vapidPrivate) {
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  console.log("[Push] VAPID keys configured for web push");
} else {
  console.warn("[Push] VAPID keys not configured — web push disabled");
}

if (expoAccessToken) {
  console.log("[Push] Expo access token configured for authenticated push requests");
} else {
  console.warn("[Push] EXPO_ACCESS_TOKEN not set — Expo push requests will be unauthenticated and may fail with InvalidCredentials");
}

let apnsProvider: apn.Provider | null = null;
if (apnsKeyId && apnsTeamId && apnsBundleId && apnsKeyPath) {
  try {
    apnsProvider = new apn.Provider({
      token: {
        key: apnsKeyPath,
        keyId: apnsKeyId,
        teamId: apnsTeamId,
      },
      production: process.env.NODE_ENV === "production",
    });
    console.log("[Push] APNs provider configured for iOS push notifications");
  } catch (err) {
    console.error("[Push] Failed to initialize APNs provider:", err);
  }
} else {
  console.warn("[Push] APNs env vars not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_KEY_PATH) — iOS native push disabled");
}

let invalidCredentialsWarned = false;

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
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (expoAccessToken) {
        headers["Authorization"] = `Bearer ${expoAccessToken}`;
      }
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers,
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

async function sendAPNsPush(
  deviceToken: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<{ success: boolean; reason?: string }> {
  if (!apnsProvider || !apnsBundleId) {
    return { success: false, reason: "APNs not configured" };
  }

  const notification = new apn.Notification();
  notification.alert = { title, body };
  notification.sound = "default";
  notification.topic = apnsBundleId;
  if (data) {
    notification.payload = data;
  }

  try {
    const result = await apnsProvider.send(notification, deviceToken);

    if (result.sent.length > 0) {
      return { success: true };
    }

    if (result.failed.length > 0) {
      const failure = result.failed[0];
      const reason = failure.response?.reason || "unknown";
      return { success: false, reason };
    }

    return { success: false, reason: "unknown" };
  } catch (err) {
    console.error("[Push] APNs send error:", err);
    return { success: false, reason: "exception" };
  }
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
      const payload = JSON.stringify({ title, body, ...data });
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

    const expoTokens = tokens.filter(t => t.platform !== "web" && t.platform !== "ios");
    const iosTokens = tokens.filter(t => t.platform === "ios");
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
          const errorType = ticket.details?.error ?? "unknown";

          if (errorType === "InvalidCredentials") {
            if (!invalidCredentialsWarned) {
              console.error(`[Push] InvalidCredentials error — the EXPO_ACCESS_TOKEN is missing or invalid. Push notifications will fail until a valid token is configured.`);
              invalidCredentialsWarned = true;
            }
          } else if (errorType === "DeviceNotRegistered") {
            const tokenToRemove = expoTokens[i]?.token;
            if (tokenToRemove) {
              await db.delete(pushTokensTable).where(eq(pushTokensTable.token, tokenToRemove));
              console.log(`[Push] Removed invalid token for user ${userId}`);
            }
          } else {
            console.error(`[Push] Ticket error for user ${userId}: ${errorType} — ${ticket.message ?? "no details"}`);
          }
        }
      }
      console.log(`[Push] Delivery result for user ${userId}: ${okCount} ok, ${errCount} error(s)`);
    }

    if (iosTokens.length > 0) {
      if (!apnsProvider) {
        console.warn(`[Push] Skipping ${iosTokens.length} iOS token(s) for user ${userId} — APNs not configured`);
      } else {
        console.log(`[Push] Sending "${title}" to user ${userId} (${iosTokens.length} APNs token(s))`);
        let apnsOk = 0;
        let apnsErr = 0;
        for (const t of iosTokens) {
          const result = await sendAPNsPush(t.token, title, body, data);
          if (result.success) {
            apnsOk++;
          } else {
            apnsErr++;
            if (result.reason === "BadDeviceToken" || result.reason === "Unregistered") {
              await db.delete(pushTokensTable).where(eq(pushTokensTable.id, t.id));
              console.log(`[Push] Removed invalid APNs token (${result.reason}) for user ${userId}`);
            } else {
              console.error(`[Push] APNs error for user ${userId}: ${result.reason}`);
            }
          }
        }
        console.log(`[Push] APNs delivery result for user ${userId}: ${apnsOk} ok, ${apnsErr} error(s)`);
      }
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
