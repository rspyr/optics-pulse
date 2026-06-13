import { db, pushTokensTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import webpush from "web-push";
import apn from "@parse/node-apn";
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

const vapidPublic = process.env.VAPID_PUBLIC_KEY;
const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || "mailto:admin@marketingos.app";
const expoAccessToken = process.env.EXPO_ACCESS_TOKEN;
const expoPushDisabled = process.env.DISABLE_EXPO_PUSH === "true";
const expoPushEnabled = Boolean(expoAccessToken) && !expoPushDisabled;

const apnsKeyId = process.env.APNS_KEY_ID;
const apnsTeamId = process.env.APNS_TEAM_ID;
const apnsBundleId = process.env.APNS_BUNDLE_ID;
const rawApnsPrivateKey = process.env.APNS_PRIVATE_KEY;
const rawApnsKeyPath = process.env.APNS_KEY_PATH;
const apnsKeyPath = rawApnsKeyPath
  ? (isAbsolute(rawApnsKeyPath) ? rawApnsKeyPath : resolve("/home/runner/workspace", rawApnsKeyPath))
  : undefined;
const apnsKey = rawApnsPrivateKey
  ? rawApnsPrivateKey.replace(/\\n/g, "\n")
  : apnsKeyPath;

if (vapidPublic && vapidPrivate) {
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  console.log("[Push] VAPID keys configured for web push");
} else {
  console.warn("[Push] VAPID keys not configured — web push disabled");
}

if (expoPushDisabled) {
  console.log("[Push] Expo push disabled; native APNs and web push remain available");
} else if (expoAccessToken) {
  console.log("[Push] Expo access token configured for authenticated push requests");
} else {
  console.log("[Push] Expo push not configured; native APNs and web push remain available");
}

let apnsProvider: apn.Provider | null = null;
if (apnsKeyId && apnsTeamId && apnsBundleId && apnsKey) {
  try {
    if (!rawApnsPrivateKey && apnsKeyPath && !existsSync(apnsKeyPath)) {
      console.warn(`[Push] APNs key file not found at "${apnsKeyPath}" — iOS native push disabled. Upload the .p8 file or set APNS_PRIVATE_KEY and restart.`);
    } else {
      apnsProvider = new apn.Provider({
        token: {
          key: apnsKey,
          keyId: apnsKeyId,
          teamId: apnsTeamId,
        },
        production: process.env.NODE_ENV === "production",
      });
      console.log("[Push] APNs provider configured for iOS push notifications");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Push] Failed to initialize APNs provider:", msg);
  }
} else {
  console.warn("[Push] APNs env vars not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_KEY_PATH) — iOS native push disabled");
}

console.log(`[Push] Startup summary — APNs: ${apnsProvider ? "READY" : "DISABLED"}, Expo: ${expoPushEnabled ? "READY" : "DISABLED"}, WebPush: ${vapidPublic && vapidPrivate ? "READY" : "DISABLED"}`);

let invalidCredentialsWarned = false;

function isExpoToken(token: string): boolean {
  return token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken[");
}

function isApnsNativeToken(token: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(token);
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

interface ExpoSendResult {
  tickets: ExpoPushTicket[];
  /** Number of messages whose chunk failed to send entirely (transient transport). */
  transportFailures: number;
}

async function sendExpoPush(messages: ExpoPushMessage[]): Promise<ExpoSendResult> {
  if (messages.length === 0) return { tickets: [], transportFailures: 0 };

  const chunks: ExpoPushMessage[][] = [];
  for (let i = 0; i < messages.length; i += 100) {
    chunks.push(messages.slice(i, i + 100));
  }

  const tickets: ExpoPushTicket[] = [];
  let transportFailures = 0;
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
      console.error("[Push] Failed to send Expo chunk:", err);
      transportFailures += chunk.length;
    }
  }

  return { tickets, transportFailures };
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
  notification.contentAvailable = true;
  notification.mutableContent = true;
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
  data: Record<string, unknown> | undefined,
  report: PushDeliveryReport,
): Promise<void> {
  if (!vapidPublic || !vapidPrivate) return;

  const webTokens = await db.select().from(pushTokensTable)
    .where(eq(pushTokensTable.userId, userId));

  const webSubs = webTokens.filter(t => t.platform === "web" && t.subscription);
  if (webSubs.length === 0) return;

  console.log(`[Push] Sending web push "${title}" to user ${userId} (${webSubs.length} sub(s))`);

  for (const sub of webSubs) {
    report.attempted++;
    try {
      const payload = JSON.stringify({ title, body, ...data });
      await webpush.sendNotification(sub.subscription as webpush.PushSubscription, payload);
      report.succeeded++;
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await db.delete(pushTokensTable).where(eq(pushTokensTable.id, sub.id));
        console.log(`[Push] Removed expired web subscription for user ${userId}`);
        report.permanentFailures++;
      } else {
        console.error(`[Push] Web push error for user ${userId}:`, err);
        report.transientFailures++;
      }
    }
  }
}

/**
 * Outcome of a push delivery attempt. Used by the durable jobs runner to
 * decide whether to retry. A push with `transientFailures > 0` and
 * `succeeded === 0` is a candidate for retry; anything else (no tokens,
 * permanent failures only, or at least one successful delivery) is final.
 */
export interface PushDeliveryReport {
  attempted: number;
  succeeded: number;
  /** Bad/expired tokens that were cleaned up — do not retry. */
  permanentFailures: number;
  /** Network, transport, or unknown provider errors — retry candidates. */
  transientFailures: number;
  /** Top-level exception (e.g. DB query failed). Always retry-able. */
  topLevelError?: Error;
}

function emptyReport(): PushDeliveryReport {
  return { attempted: 0, succeeded: 0, permanentFailures: 0, transientFailures: 0 };
}

export async function sendPushToUser(
  userId: number,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<PushDeliveryReport> {
  const report = emptyReport();
  try {
    const tokens = await db.select().from(pushTokensTable).where(eq(pushTokensTable.userId, userId));
    if (tokens.length === 0) {
      console.log(`[Push] No tokens registered for user ${userId}, skipping`);
      return report;
    }

    const allExpoTokens = tokens.filter(t => t.platform !== "web" && isExpoToken(t.token));
    const expoTokens = expoPushEnabled ? allExpoTokens : [];
    const apnsTokens = tokens.filter(t => t.platform !== "web" && isApnsNativeToken(t.token));
    const hasWebTokens = tokens.some(t => t.platform === "web");

    const unclassified = tokens.filter(t =>
      t.platform !== "web" && !isExpoToken(t.token) && !isApnsNativeToken(t.token)
    );
    if (unclassified.length > 0) {
      console.warn(`[Push] User ${userId} has ${unclassified.length} unclassified token(s) — tokens: ${unclassified.map(t => `"${t.token.substring(0, 20)}..." (platform=${t.platform})`).join(", ")}`);
    }
    if (!expoPushEnabled && allExpoTokens.length > 0) {
      console.log(`[Push] Skipping ${allExpoTokens.length} Expo token(s) for user ${userId} because Expo push is disabled`);
    }

    if (expoTokens.length > 0) {
      console.log(`[Push] Sending via Expo "${title}" to user ${userId} (${expoTokens.length} token(s))`);

      const messages: ExpoPushMessage[] = expoTokens.map(t => ({
        to: t.token,
        title,
        body,
        data,
        sound: "default",
      }));

      report.attempted += expoTokens.length;
      const { tickets, transportFailures } = await sendExpoPush(messages);
      // Chunk-level transport failures (fetch threw) — count each affected
      // message as transient so the job can retry.
      report.transientFailures += transportFailures;

      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === "ok") {
          report.succeeded++;
        } else if (ticket.status === "error") {
          const errorType = ticket.details?.error ?? "unknown";

          if (errorType === "InvalidCredentials") {
            if (!invalidCredentialsWarned) {
              console.error(`[Push] InvalidCredentials error — the EXPO_ACCESS_TOKEN is missing or invalid. Push notifications will fail until a valid token is configured.`);
              invalidCredentialsWarned = true;
            }
            // Bad server config — retrying after a token rotation will work,
            // so treat as transient.
            report.transientFailures++;
          } else if (errorType === "DeviceNotRegistered") {
            const tokenToRemove = expoTokens[i]?.token;
            if (tokenToRemove) {
              await db.delete(pushTokensTable).where(eq(pushTokensTable.token, tokenToRemove));
              console.log(`[Push] Removed invalid Expo token for user ${userId}`);
            }
            report.permanentFailures++;
          } else {
            console.error(`[Push] Expo ticket error for user ${userId}: ${errorType} — ${ticket.message ?? "no details"}`);
            report.transientFailures++;
          }
        }
      }
      console.log(`[Push] Expo delivery result for user ${userId}: ${report.succeeded} ok, ${tickets.filter(t => t.status === "error").length + transportFailures} error(s)`);
    }

    if (apnsTokens.length > 0) {
      if (!apnsProvider) {
        console.warn(`[Push] Skipping ${apnsTokens.length} APNs token(s) for user ${userId} — APNs not configured`);
      } else {
        console.log(`[Push] Sending via APNs "${title}" to user ${userId} (${apnsTokens.length} token(s))`);
        for (const t of apnsTokens) {
          report.attempted++;
          const result = await sendAPNsPush(t.token, title, body, data);
          if (result.success) {
            report.succeeded++;
          } else {
            if (result.reason === "BadDeviceToken" || result.reason === "Unregistered") {
              await db.delete(pushTokensTable).where(eq(pushTokensTable.id, t.id));
              console.log(`[Push] Removed invalid APNs token (${result.reason}) for user ${userId}`);
              report.permanentFailures++;
            } else {
              console.error(`[Push] APNs error for user ${userId}: ${result.reason}`);
              report.transientFailures++;
            }
          }
        }
      }
    }

    if (hasWebTokens) {
      await sendWebPushToUser(userId, title, body, data, report);
    }
  } catch (err) {
    console.error(`[Push] Error sending to user ${userId}:`, err);
    report.topLevelError = err instanceof Error ? err : new Error(String(err));
  }
  return report;
}

export async function sendPushToTenantUsers(
  tenantId: number,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  excludeUserId?: number,
): Promise<PushDeliveryReport> {
  const report = emptyReport();
  try {
    const { usersTable } = await import("@workspace/db");
    const { eq: eqOp, and: andOp } = await import("drizzle-orm");

    const users = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(andOp(eqOp(usersTable.tenantId, tenantId), eqOp(usersTable.isActive, true)));

    for (const user of users) {
      if (excludeUserId && user.id === excludeUserId) continue;
      const sub = await sendPushToUser(user.id, title, body, data);
      report.attempted += sub.attempted;
      report.succeeded += sub.succeeded;
      report.permanentFailures += sub.permanentFailures;
      report.transientFailures += sub.transientFailures;
      // If any individual user delivery had a top-level error, surface it
      // so the job runner can retry the whole broadcast.
      if (sub.topLevelError && !report.topLevelError) {
        report.topLevelError = sub.topLevelError;
      }
    }
  } catch (err) {
    console.error(`[Push] Error sending to tenant ${tenantId}:`, err);
    report.topLevelError = err instanceof Error ? err : new Error(String(err));
  }
  return report;
}
