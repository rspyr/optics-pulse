import { Router, type IRouter } from "express";
import { db, attributionEventsTable, leadsTable, jobsTable } from "@workspace/db";
import { eq, and, count, desc, isNull, SQL } from "drizzle-orm";
import { ListAttributionEventsQueryParams } from "@workspace/api-zod";
import crypto from "crypto";

const router: IRouter = Router();

function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

router.get("/attribution/events", async (req, res) => {
  const query = ListAttributionEventsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  if (query.tenantId) conditions.push(eq(attributionEventsTable.tenantId, query.tenantId));
  if (query.matchLevel) {
    const level = query.matchLevel as "diamond" | "golden" | "silver" | "bronze" | "unmatched";
    conditions.push(eq(attributionEventsTable.matchLevel, level));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const [events, [totalResult]] = await Promise.all([
    db.select().from(attributionEventsTable).where(where).orderBy(desc(attributionEventsTable.createdAt)).limit(limit).offset(offset),
    db.select({ count: count() }).from(attributionEventsTable).where(where),
  ]);

  res.json({ events, total: totalResult.count });
});

router.post("/attribution/reconcile", async (req, res) => {
  const tenantId = req.body.tenantId ? Number(req.body.tenantId) : null;
  const results = { diamond: 0, golden: 0, silver: 0, bronze: 0, unmatched: 0 };

  const jobConditions: SQL[] = [];
  jobConditions.push(isNull(jobsTable.matchLevel));
  if (tenantId) jobConditions.push(eq(jobsTable.tenantId, tenantId));
  const unmatchedJobs = await db.select().from(jobsTable).where(and(...jobConditions));

  for (const job of unmatchedJobs) {
    let matched = false;

    if (job.matchedGclid) {
      const [event] = await db.select().from(attributionEventsTable)
        .where(and(eq(attributionEventsTable.gclid, job.matchedGclid), eq(attributionEventsTable.tenantId, job.tenantId)))
        .limit(1);
      if (event) {
        await db.update(jobsTable).set({ matchLevel: "diamond", updatedAt: new Date() }).where(eq(jobsTable.id, job.id));
        results.diamond++;
        continue;
      }
    }

    const nameParts = job.customerName.split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";
    const leads = await db.select().from(leadsTable)
      .where(and(eq(leadsTable.tenantId, job.tenantId), eq(leadsTable.firstName, firstName)))
      .limit(10);

    for (const lead of leads) {
      if (lead.phone) {
        const hashedPhone = hashValue(lead.phone.replace(/[\s\-\(\)\+]/g, "").replace(/^1/, ""));
        const [phoneEvent] = await db.select().from(attributionEventsTable)
          .where(and(
            eq(attributionEventsTable.tenantId, job.tenantId),
            eq(attributionEventsTable.hashedPhone, hashedPhone)
          ))
          .limit(1);
        if (phoneEvent) {
          await db.update(jobsTable).set({ matchLevel: "golden", updatedAt: new Date() }).where(eq(jobsTable.id, job.id));
          results.golden++;
          matched = true;
          break;
        }
      }

      if (lead.email) {
        const hashedEmail = hashValue(lead.email);
        const [emailEvent] = await db.select().from(attributionEventsTable)
          .where(and(
            eq(attributionEventsTable.tenantId, job.tenantId),
            eq(attributionEventsTable.hashedEmail, hashedEmail)
          ))
          .limit(1);
        if (emailEvent) {
          await db.update(jobsTable).set({ matchLevel: "silver", updatedAt: new Date() }).where(eq(jobsTable.id, job.id));
          results.silver++;
          matched = true;
          break;
        }
      }
    }

    if (matched) continue;

    const nameParts2 = job.customerName.split(" ");
    const jobLastName = nameParts2.slice(1).join(" ") || nameParts2[0] || "";
    const addressLeads = await db.select().from(leadsTable)
      .where(and(eq(leadsTable.tenantId, job.tenantId), eq(leadsTable.lastName, jobLastName)))
      .limit(10);

    let bronzeMatched = false;
    for (const addrLead of addressLeads) {
      const addressEvents = await db.select().from(attributionEventsTable)
        .where(and(
          eq(attributionEventsTable.tenantId, job.tenantId),
          eq(attributionEventsTable.matchLevel, "bronze")
        ))
        .limit(10);

      for (const addrEvent of addressEvents) {
        if (addrEvent.billingAddress) {
          await db.update(jobsTable).set({
            matchLevel: "bronze",
            matchedGclid: null,
            updatedAt: new Date()
          }).where(eq(jobsTable.id, job.id));
          results.bronze++;
          bronzeMatched = true;
          break;
        }
      }
      if (bronzeMatched) break;
    }
    if (bronzeMatched) continue;

    await db.update(jobsTable).set({ matchLevel: "unmatched", updatedAt: new Date() }).where(eq(jobsTable.id, job.id));
    results.unmatched++;
  }

  res.json({
    success: true,
    reconciled: unmatchedJobs.length,
    breakdown: results,
    message: `Reconciled ${unmatchedJobs.length} jobs: ${results.diamond} diamond, ${results.golden} golden, ${results.silver} silver, ${results.bronze} bronze, ${results.unmatched} unmatched`,
  });
});

export default router;
