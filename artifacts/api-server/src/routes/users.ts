import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const ALLOWED_PREF_KEYS: Record<string, (v: unknown) => boolean> = {
  soundEnabled: (v) => typeof v === "boolean",
};

router.get("/users/me/preferences", async (req, res) => {
  try {
    const userId = req.session.userId!;
    const [user] = await db
      .select({ preferences: usersTable.preferences })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    res.json(user?.preferences ?? {});
  } catch (err) {
    console.error("GET /users/me/preferences error:", err);
    res.status(500).json({ error: "Failed to fetch preferences" });
  }
});

router.patch("/users/me/preferences", async (req, res) => {
  try {
    const userId = req.session.userId!;
    const incoming = req.body;

    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      res.status(400).json({ error: "Body must be a JSON object" });
      return;
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) {
      const validator = ALLOWED_PREF_KEYS[key];
      if (!validator) {
        res.status(400).json({ error: `Unknown preference key: ${key}` });
        return;
      }
      if (!validator(value)) {
        res.status(400).json({ error: `Invalid value for preference "${key}"` });
        return;
      }
      sanitized[key] = value;
    }

    const [user] = await db
      .select({ preferences: usersTable.preferences })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    const merged = { ...(user?.preferences ?? {}), ...sanitized };

    await db
      .update(usersTable)
      .set({ preferences: merged, updatedAt: new Date() })
      .where(eq(usersTable.id, userId));

    res.json(merged);
  } catch (err) {
    console.error("PATCH /users/me/preferences error:", err);
    res.status(500).json({ error: "Failed to update preferences" });
  }
});

export default router;
