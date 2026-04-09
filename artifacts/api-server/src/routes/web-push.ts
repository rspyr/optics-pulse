import { Router, type IRouter } from "express";
import { db, pushTokensTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

router.get("/web-push/vapid-key", (_req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    res.status(500).json({ error: "VAPID not configured" });
    return;
  }
  res.json({ publicKey: key });
});

const ALLOWED_PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
  "web.push.apple.com",
];

function isValidPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return false;
    return ALLOWED_PUSH_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

router.post("/web-push/subscribe", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) {
    res.status(400).json({ error: "subscription with endpoint is required" });
    return;
  }

  if (!isValidPushEndpoint(subscription.endpoint)) {
    res.status(400).json({ error: "Invalid push endpoint" });
    return;
  }

  const token = subscription.endpoint;

  try {
    const existing = await db.select().from(pushTokensTable)
      .where(and(eq(pushTokensTable.userId, userId), eq(pushTokensTable.token, token)));

    if (existing.length > 0) {
      await db.update(pushTokensTable)
        .set({ subscription })
        .where(eq(pushTokensTable.id, existing[0].id));
      res.json({ success: true, id: existing[0].id });
      return;
    }

    const [inserted] = await db.insert(pushTokensTable).values({
      userId,
      token,
      platform: "web",
      subscription,
    }).returning();

    console.log(`[WebPush] Registered subscription for user ${userId}`);
    res.json({ success: true, id: inserted.id });
  } catch (err) {
    console.error("[WebPush] Error subscribing:", err);
    res.status(500).json({ error: "Failed to subscribe" });
  }
});

router.delete("/web-push/unsubscribe", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const { endpoint } = req.body;
  if (!endpoint) {
    res.status(400).json({ error: "endpoint is required" });
    return;
  }

  try {
    await db.delete(pushTokensTable)
      .where(and(eq(pushTokensTable.userId, userId), eq(pushTokensTable.token, endpoint)));
    console.log(`[WebPush] Unsubscribed user ${userId}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[WebPush] Error unsubscribing:", err);
    res.status(500).json({ error: "Failed to unsubscribe" });
  }
});

export default router;
