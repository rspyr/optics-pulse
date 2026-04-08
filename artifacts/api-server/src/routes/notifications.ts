import { Router, type IRouter } from "express";
import { db, notificationsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireRole } from "../middleware/auth";

const router: IRouter = Router();

const AGENCY_ROLES = ["super_admin", "agency_user"];

function tenantScope(req: { session: { userRole?: string; tenantId?: number | null } }) {
  const role = req.session.userRole;
  if (role === "super_admin" || role === "agency_user") {
    return undefined;
  }
  const tenantId = req.session.tenantId;
  if (tenantId) {
    return eq(notificationsTable.tenantId, tenantId);
  }
  return sql`false`;
}

router.get("/notifications", requireRole(...AGENCY_ROLES), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const includeRead = req.query.includeRead === "true";
    const includeDismissed = req.query.includeDismissed === "true";

    const conditions = [];
    const scope = tenantScope(req);
    if (scope) conditions.push(scope);
    if (!includeDismissed) conditions.push(eq(notificationsTable.isDismissed, false));
    if (!includeRead) conditions.push(eq(notificationsTable.isRead, false));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const notifications = await db.select()
      .from(notificationsTable)
      .where(where)
      .orderBy(desc(notificationsTable.createdAt))
      .limit(limit)
      .offset(offset);

    const [countResult] = await db.select({
      count: sql<number>`count(*)::int`,
    }).from(notificationsTable).where(where);

    const unreadConditions = [
      eq(notificationsTable.isRead, false),
      eq(notificationsTable.isDismissed, false),
    ];
    if (scope) unreadConditions.push(scope);

    const [unreadCount] = await db.select({
      count: sql<number>`count(*)::int`,
    }).from(notificationsTable).where(and(...unreadConditions));

    res.json({
      notifications,
      total: countResult?.count || 0,
      unread: unreadCount?.count || 0,
    });
  } catch (error) {
    console.error("[Notifications] List error:", error);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

router.get("/notifications/unread-count", requireRole(...AGENCY_ROLES), async (req, res) => {
  try {
    const conditions = [
      eq(notificationsTable.isRead, false),
      eq(notificationsTable.isDismissed, false),
    ];
    const scope = tenantScope(req);
    if (scope) conditions.push(scope);

    const baseWhere = and(...conditions);

    const [result] = await db.select({
      count: sql<number>`count(*)::int`,
    }).from(notificationsTable).where(baseWhere);

    const criticalConditions = [...conditions, eq(notificationsTable.severity, "critical")];
    const [criticalResult] = await db.select({
      count: sql<number>`count(*)::int`,
    }).from(notificationsTable).where(and(...criticalConditions));

    res.json({
      count: result?.count || 0,
      hasCriticalUnread: (criticalResult?.count || 0) > 0,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get unread count" });
  }
});

router.get("/notifications/history", requireRole(...AGENCY_ROLES), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;

    const scope = tenantScope(req);
    const notifications = await db.select()
      .from(notificationsTable)
      .where(scope)
      .orderBy(desc(notificationsTable.createdAt))
      .limit(limit)
      .offset(offset);

    const [countResult] = await db.select({
      count: sql<number>`count(*)::int`,
    }).from(notificationsTable).where(scope);

    res.json({
      notifications,
      total: countResult?.count || 0,
    });
  } catch (error) {
    console.error("[Notifications] History error:", error);
    res.status(500).json({ error: "Failed to fetch notification history" });
  }
});

router.patch("/notifications/:id/read", requireRole(...AGENCY_ROLES), async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid notification ID" });
      return;
    }

    const conditions = [eq(notificationsTable.id, id)];
    const scope = tenantScope(req);
    if (scope) conditions.push(scope);

    const result = await db.update(notificationsTable)
      .set({ isRead: true, readAt: new Date() })
      .where(and(...conditions))
      .returning({ id: notificationsTable.id });

    if (result.length === 0) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to mark as read" });
  }
});

router.patch("/notifications/:id/dismiss", requireRole(...AGENCY_ROLES), async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid notification ID" });
      return;
    }

    const conditions = [eq(notificationsTable.id, id)];
    const scope = tenantScope(req);
    if (scope) conditions.push(scope);

    const result = await db.update(notificationsTable)
      .set({ isDismissed: true, dismissedAt: new Date(), isRead: true, readAt: new Date() })
      .where(and(...conditions))
      .returning({ id: notificationsTable.id });

    if (result.length === 0) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to dismiss notification" });
  }
});

router.post("/notifications/read-all", requireRole(...AGENCY_ROLES), async (req, res) => {
  try {
    const conditions = [eq(notificationsTable.isRead, false)];
    const scope = tenantScope(req);
    if (scope) conditions.push(scope);

    await db.update(notificationsTable)
      .set({ isRead: true, readAt: new Date() })
      .where(and(...conditions));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to mark all as read" });
  }
});

router.post("/notifications/dismiss-all", requireRole(...AGENCY_ROLES), async (req, res) => {
  try {
    const conditions = [eq(notificationsTable.isDismissed, false)];
    const scope = tenantScope(req);
    if (scope) conditions.push(scope);

    await db.update(notificationsTable)
      .set({ isDismissed: true, dismissedAt: new Date(), isRead: true, readAt: new Date() })
      .where(and(...conditions));

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to dismiss all" });
  }
});

export default router;
