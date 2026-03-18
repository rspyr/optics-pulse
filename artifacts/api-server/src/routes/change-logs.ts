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

router.post("/change-logs", requireRole("super_admin", "agency_user"), async (req, res) => {
  const { tenantId, date, title, description, category } = req.body;

  if (!tenantId || !date || !title || !description) {
    return res.status(400).json({ error: "tenantId, date, title, and description are required" });
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

export default router;
