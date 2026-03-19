import { Router, type IRouter } from "express";
import { db, trackerHeartbeatsTable, tenantsTable } from "@workspace/db";
import { eq, and, lt, desc } from "drizzle-orm";

const router: IRouter = Router();

router.post("/tracker/heartbeat", async (req, res) => {
  try {
    const tenantId = req.body.tenantId ? Number(req.body.tenantId) : null;
    const domain = req.body.domain || req.headers.origin || null;
    const userAgent = req.headers["user-agent"] || null;

    if (!tenantId) {
      res.status(400).json({ error: "tenantId is required" });
      return;
    }

    const existing = await db.select().from(trackerHeartbeatsTable)
      .where(and(
        eq(trackerHeartbeatsTable.tenantId, tenantId),
        ...(domain ? [eq(trackerHeartbeatsTable.domain, domain)] : []),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(trackerHeartbeatsTable)
        .set({ lastSeenAt: new Date(), userAgent })
        .where(eq(trackerHeartbeatsTable.id, existing[0].id));
    } else {
      await db.insert(trackerHeartbeatsTable).values({
        tenantId,
        domain,
        userAgent,
      });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to record heartbeat" });
  }
});

router.get("/tracker/health", async (_req, res) => {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
  const heartbeats = await db.select().from(trackerHeartbeatsTable);

  const health = tenants.map(t => {
    const hb = heartbeats.filter(h => h.tenantId === t.id);
    const latest = hb.sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())[0];
    const isHealthy = latest ? new Date(latest.lastSeenAt) > twentyFourHoursAgo : false;
    return {
      tenantId: t.id,
      tenantName: t.name,
      isHealthy,
      lastSeen: latest?.lastSeenAt || null,
      domain: latest?.domain || null,
    };
  });

  res.json(health);
});

export default router;
