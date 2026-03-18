import { Router, type IRouter } from "express";
import { db, automationRulesTable, automationAlertsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireRole } from "../middleware/auth";

const router: IRouter = Router();

const agencyOnly = [requireRole("super_admin", "agency_user")];

const VALID_CONDITIONS = ["spend_below", "spend_above", "days_active_above", "conversions_below", "cpl_above", "roas_below"];
const VALID_ACTIONS = ["send_alert", "flag_for_review", "auto_pause"];

function validateId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

router.get("/automation/rules", ...agencyOnly, async (_req, res) => {
  try {
    const rules = await db.select().from(automationRulesTable).orderBy(desc(automationRulesTable.createdAt));
    res.json(rules);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to list rules";
    res.status(500).json({ error: msg });
  }
});

router.post("/automation/rules", ...agencyOnly, async (req, res) => {
  try {
    const { name, description, conditionType, conditionValue, actionType, platform, tenantId, lookbackDays } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" }); return;
    }
    if (!VALID_CONDITIONS.includes(conditionType)) {
      res.status(400).json({ error: `conditionType must be one of: ${VALID_CONDITIONS.join(", ")}` }); return;
    }
    if (!Number.isFinite(Number(conditionValue)) || Number(conditionValue) < 0) {
      res.status(400).json({ error: "conditionValue must be a valid non-negative number" }); return;
    }
    if (!VALID_ACTIONS.includes(actionType)) {
      res.status(400).json({ error: `actionType must be one of: ${VALID_ACTIONS.join(", ")}` }); return;
    }

    const userId = req.session.userId!;

    const parsedLookback = lookbackDays ? Number(lookbackDays) : 30;
    if (!Number.isFinite(parsedLookback) || parsedLookback < 1 || parsedLookback > 365) {
      res.status(400).json({ error: "lookbackDays must be between 1 and 365" }); return;
    }

    const insertValues: typeof automationRulesTable.$inferInsert = {
      name: name.trim(),
      description: description?.trim() || null,
      conditionType: conditionType,
      conditionValue: Number(conditionValue),
      actionType: actionType,
      lookbackDays: parsedLookback,
      platform: platform?.trim().toLowerCase() || null,
      tenantId: tenantId ? Number(tenantId) : null,
      createdBy: userId,
    };
    const [rule] = await db.insert(automationRulesTable).values(insertValues).returning();

    res.status(201).json(rule);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to create rule";
    res.status(500).json({ error: msg });
  }
});

router.put("/automation/rules/:id", ...agencyOnly, async (req, res) => {
  try {
    const id = validateId(String(req.params.id));
    if (!id) { res.status(400).json({ error: "Invalid rule ID" }); return; }

    const { name, description, conditionType, conditionValue, actionType, platform, tenantId, isEnabled, lookbackDays } = req.body;

    if (conditionType !== undefined && !VALID_CONDITIONS.includes(conditionType)) {
      res.status(400).json({ error: `conditionType must be one of: ${VALID_CONDITIONS.join(", ")}` }); return;
    }
    if (conditionValue !== undefined && (!Number.isFinite(Number(conditionValue)) || Number(conditionValue) < 0)) {
      res.status(400).json({ error: "conditionValue must be a valid non-negative number" }); return;
    }
    if (actionType !== undefined && !VALID_ACTIONS.includes(actionType)) {
      res.status(400).json({ error: `actionType must be one of: ${VALID_ACTIONS.join(", ")}` }); return;
    }
    if (lookbackDays !== undefined) {
      const lb = Number(lookbackDays);
      if (!Number.isFinite(lb) || lb < 1 || lb > 365) {
        res.status(400).json({ error: "lookbackDays must be between 1 and 365" }); return;
      }
    }

    const [rule] = await db.update(automationRulesTable).set({
      ...(name !== undefined && { name: String(name).trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(conditionType !== undefined && { conditionType }),
      ...(conditionValue !== undefined && { conditionValue: Number(conditionValue) }),
      ...(actionType !== undefined && { actionType }),
      ...(lookbackDays !== undefined && { lookbackDays: Number(lookbackDays) }),
      ...(platform !== undefined && { platform: platform?.trim().toLowerCase() || null }),
      ...(tenantId !== undefined && { tenantId: tenantId ? Number(tenantId) : null }),
      ...(isEnabled !== undefined && { isEnabled }),
      updatedAt: new Date(),
    }).where(eq(automationRulesTable.id, id)).returning();

    if (!rule) { res.status(404).json({ error: "Rule not found" }); return; }
    res.json(rule);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to update rule";
    res.status(500).json({ error: msg });
  }
});

router.patch("/automation/rules/:id/toggle", ...agencyOnly, async (req, res) => {
  try {
    const id = validateId(String(req.params.id));
    if (!id) { res.status(400).json({ error: "Invalid rule ID" }); return; }

    const existing = await db.select().from(automationRulesTable).where(eq(automationRulesTable.id, id));
    if (existing.length === 0) { res.status(404).json({ error: "Rule not found" }); return; }

    const [rule] = await db.update(automationRulesTable).set({
      isEnabled: !existing[0].isEnabled,
      updatedAt: new Date(),
    }).where(eq(automationRulesTable.id, id)).returning();

    res.json(rule);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to toggle rule";
    res.status(500).json({ error: msg });
  }
});

router.delete("/automation/rules/:id", ...agencyOnly, async (req, res) => {
  try {
    const id = validateId(String(req.params.id));
    if (!id) { res.status(400).json({ error: "Invalid rule ID" }); return; }

    await db.delete(automationAlertsTable).where(eq(automationAlertsTable.ruleId, id));
    const [rule] = await db.delete(automationRulesTable).where(eq(automationRulesTable.id, id)).returning();

    if (!rule) { res.status(404).json({ error: "Rule not found" }); return; }
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to delete rule";
    res.status(500).json({ error: msg });
  }
});

router.get("/automation/alerts", ...agencyOnly, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const acknowledged = req.query.acknowledged;

    const conditions = [];
    if (acknowledged === "true") {
      conditions.push(eq(automationAlertsTable.isAcknowledged, true));
    } else if (acknowledged === "false") {
      conditions.push(eq(automationAlertsTable.isAcknowledged, false));
    }

    const alerts = conditions.length > 0
      ? await db.select().from(automationAlertsTable).where(and(...conditions)).orderBy(desc(automationAlertsTable.createdAt)).limit(limit)
      : await db.select().from(automationAlertsTable).orderBy(desc(automationAlertsTable.createdAt)).limit(limit);

    res.json(alerts);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to list alerts";
    res.status(500).json({ error: msg });
  }
});

router.patch("/automation/alerts/:id/acknowledge", ...agencyOnly, async (req, res) => {
  try {
    const id = validateId(String(req.params.id));
    if (!id) { res.status(400).json({ error: "Invalid alert ID" }); return; }

    const userId = req.session.userId!;

    const [alert] = await db.update(automationAlertsTable).set({
      isAcknowledged: true,
      acknowledgedBy: userId,
      acknowledgedAt: new Date(),
    }).where(eq(automationAlertsTable.id, id)).returning();

    if (!alert) { res.status(404).json({ error: "Alert not found" }); return; }
    res.json(alert);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to acknowledge alert";
    res.status(500).json({ error: msg });
  }
});

router.get("/automation/alerts/count", ...agencyOnly, async (_req, res) => {
  try {
    const [result] = await db.select({ count: sql<number>`COUNT(*)::int` }).from(automationAlertsTable).where(eq(automationAlertsTable.isAcknowledged, false));
    res.json({ unacknowledged: result?.count ?? 0 });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to count alerts";
    res.status(500).json({ error: msg });
  }
});

export default router;
