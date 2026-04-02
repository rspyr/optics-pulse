import { Router, type IRouter } from "express";
import { db, pushTokensTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

router.post("/push-tokens", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const { token, platform } = req.body;
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "token is required" }); return;
  }

  try {
    const existing = await db.select().from(pushTokensTable)
      .where(and(eq(pushTokensTable.userId, userId), eq(pushTokensTable.token, token)));

    if (existing.length > 0) {
      res.json({ success: true, id: existing[0].id });
      return;
    }

    const [inserted] = await db.insert(pushTokensTable).values({
      userId,
      token,
      platform: platform || "expo",
    }).returning();

    res.json({ success: true, id: inserted.id });
  } catch (err) {
    console.error("[PushTokens] Error registering token:", err);
    res.status(500).json({ error: "Failed to register push token" });
  }
});

router.delete("/push-tokens", async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const { token } = req.body;
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "token is required" }); return;
  }

  try {
    await db.delete(pushTokensTable)
      .where(and(eq(pushTokensTable.userId, userId), eq(pushTokensTable.token, token)));
    res.json({ success: true });
  } catch (err) {
    console.error("[PushTokens] Error deleting token:", err);
    res.status(500).json({ error: "Failed to delete push token" });
  }
});

export default router;
