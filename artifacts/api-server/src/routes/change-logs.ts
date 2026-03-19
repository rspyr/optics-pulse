import { Router, type IRouter } from "express";
import { db, changeLogsTable } from "@workspace/db";
import { eq, and, gte, lte, desc, SQL } from "drizzle-orm";
import { requireRole } from "../middleware/auth";

const router: IRouter = Router();

router.get("/change-logs", async (req, res) => {
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;

  const conditions: SQL[] = [];
  if (tenantId) conditions.push(eq(changeLogsTable.tenantId, tenantId));
  if (startDate) conditions.push(gte(changeLogsTable.date, startDate));
  if (endDate) conditions.push(lte(changeLogsTable.date, endDate));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const logs = await db.select().from(changeLogsTable).where(where).orderBy(desc(changeLogsTable.date));

  res.json(logs);
});

router.post("/change-logs", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const { tenantId, date, title, description, category } = req.body;

  if (!tenantId || !date || !title || !description) {
    res.status(400).json({ error: "tenantId, date, title, and description are required" });
    return;
  }

  const [log] = await db.insert(changeLogsTable).values({
    tenantId,
    date,
    title,
    description,
    category: category || "general",
  }).returning();

  res.status(201).json(log);
});

router.put("/change-logs/:id", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id));
  const { date, title, description, category } = req.body;

  const updates: Record<string, unknown> = {};
  if (date) updates.date = date;
  if (title) updates.title = title;
  if (description) updates.description = description;
  if (category) updates.category = category;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [log] = await db.update(changeLogsTable).set(updates).where(eq(changeLogsTable.id, id)).returning();
  if (!log) {
    res.status(404).json({ error: "Change log not found" });
    return;
  }
  res.json(log);
});

router.delete("/change-logs/:id", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id));
  const [log] = await db.delete(changeLogsTable).where(eq(changeLogsTable.id, id)).returning();
  if (!log) {
    res.status(404).json({ error: "Change log not found" });
    return;
  }
  res.json({ success: true });
});

export default router;
