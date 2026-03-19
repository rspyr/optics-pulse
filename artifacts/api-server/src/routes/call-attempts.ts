import { Router, type IRouter } from "express";
import { db, callAttemptsTable, leadsTable } from "@workspace/db";
import { eq, desc, and, gte, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/call-attempts/:leadId", async (req, res) => {
  const leadId = parseInt(String(req.params.leadId));
  const attempts = await db.select().from(callAttemptsTable)
    .where(eq(callAttemptsTable.leadId, leadId))
    .orderBy(desc(callAttemptsTable.attemptedAt));
  res.json(attempts);
});

router.post("/call-attempts", async (req, res): Promise<void> => {
  const { leadId, outcome, notes } = req.body;
  const userId = req.session.userId;

  if (!leadId || !outcome || !userId) {
    res.status(400).json({ error: "leadId and outcome are required" });
    return;
  }

  const [attempt] = await db.insert(callAttemptsTable).values({
    leadId,
    userId,
    outcome,
    notes: notes || null,
  }).returning();

  res.status(201).json(attempt);
});

router.get("/call-attempts/:leadId/suggest", async (req, res) => {
  const leadId = parseInt(String(req.params.leadId));

  const attempts = await db.select().from(callAttemptsTable)
    .where(eq(callAttemptsTable.leadId, leadId))
    .orderBy(desc(callAttemptsTable.attemptedAt));

  if (attempts.length === 0) {
    res.json({ suggestion: "New lead — call immediately", bestTimeWindow: null, doubleDial: false });
    return;
  }

  const hourCounts = new Map<number, { total: number; noAnswer: number }>();
  for (const a of attempts) {
    const hour = new Date(a.attemptedAt).getHours();
    const entry = hourCounts.get(hour) || { total: 0, noAnswer: 0 };
    entry.total++;
    if (a.outcome === "no_answer" || a.outcome === "voicemail") entry.noAnswer++;
    hourCounts.set(hour, entry);
  }

  const triedHours = [...hourCounts.entries()];
  const allNoAnswer = triedHours.every(([_, v]) => v.noAnswer === v.total);

  const lastAttempt = attempts[0];
  const lastHour = new Date(lastAttempt.attemptedAt).getHours();
  const lastDay = new Date(lastAttempt.attemptedAt).getDay();
  const isMorning = lastHour < 12;

  let suggestion = "";
  let bestTimeWindow = "";
  let doubleDial = false;

  if (allNoAnswer && triedHours.length >= 3) {
    const isWeekdayOnly = attempts.every(a => {
      const d = new Date(a.attemptedAt).getDay();
      return d >= 1 && d <= 5;
    });
    if (isWeekdayOnly) {
      suggestion = "No answer during weekday business hours — try Saturday 10am-12pm";
      bestTimeWindow = "Saturday 10:00-12:00";
    } else {
      suggestion = "Multiple attempts with no answer — try early evening 5-7pm";
      bestTimeWindow = "Weekday 17:00-19:00";
    }
  } else if (lastAttempt.outcome === "no_answer" || lastAttempt.outcome === "voicemail") {
    doubleDial = true;
    if (isMorning) {
      suggestion = `No answer this morning — try again this afternoon around ${lastHour + 6 > 17 ? 17 : lastHour + 6}:00`;
      bestTimeWindow = `Today ${lastHour + 6 > 17 ? 17 : lastHour + 6}:00-${lastHour + 7 > 18 ? 18 : lastHour + 7}:00`;
    } else {
      suggestion = "No answer this afternoon — try tomorrow morning 9-10am";
      bestTimeWindow = "Tomorrow 09:00-10:00";
    }
  } else {
    suggestion = "Previous contact made — follow up during similar time window";
    bestTimeWindow = `${lastHour}:00-${lastHour + 1}:00`;
  }

  res.json({ suggestion, bestTimeWindow, doubleDial, totalAttempts: attempts.length });
});

export default router;
