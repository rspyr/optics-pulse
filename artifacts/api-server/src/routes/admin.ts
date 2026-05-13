import { Router, type IRouter } from "express";
import { db, usersTable, tenantsTable, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable, trainingPurchasesTable, trainingItemsTable } from "@workspace/db";
import { eq, and, sql, gte, lte, count, sum, avg, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { requireAuth, requireRole } from "../middleware/auth";
import { pool } from "@workspace/db";
import { backfillMetaAdCreatives } from "../services/sync-scheduler";
import { findUsersWithoutTenant } from "../services/broken-account-audit";

const router: IRouter = Router();

const agencyOnly = [requireRole("super_admin", "agency_user")];

/**
 * Surface the same data as the startup `[broken-account-audit]` log
 * to admins in the UI, so they can act on broken accounts without
 * needing API server log access. See task #400.
 */
router.get("/admin/broken-accounts", ...agencyOnly, async (_req, res) => {
  try {
    const broken = await findUsersWithoutTenant();
    res.json({
      brokenCount: broken.length,
      brokenAccounts: broken,
      scannedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to load broken accounts";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/users", ...agencyOnly, async (req, res) => {
  try {
    const users = await db.select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      role: usersTable.role,
      tenantId: usersTable.tenantId,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    }).from(usersTable);

    res.json(users);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to list users";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/users", ...agencyOnly, async (req, res) => {
  try {
    const { email, name, password, role, tenantId } = req.body as {
      email: string;
      name: string;
      password: string;
      role: string;
      tenantId: number | null;
    };

    if (!email || !name || !password || !role) {
      res.status(400).json({ error: "email, name, password, and role are required" });
      return;
    }

    const validRoles = ["super_admin", "agency_user", "client_admin", "client_user"] as const;
    if (!validRoles.includes(role as typeof validRoles[number])) {
      res.status(400).json({ error: `role must be one of: ${validRoles.join(", ")}` });
      return;
    }

    // A non-admin role (client_admin / client_user / any future
    // tenant-scoped role) without a tenantId is a broken account that
    // would 403 on every list endpoint via resolveListTenantScope.
    // Reject at creation so this state never enters the DB.
    const isAdminRole = role === "super_admin" || role === "agency_user";
    const normalizedTenantId = tenantId ?? null;
    if (!isAdminRole && !normalizedTenantId) {
      res.status(400).json({
        error: `tenantId is required for role "${role}". Only super_admin and agency_user may be created without a tenant.`,
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [user] = await db.insert(usersTable).values({
      email: email.toLowerCase(),
      name,
      passwordHash,
      role: role as typeof validRoles[number],
      tenantId: normalizedTenantId,
    }).returning();

    res.status(201).json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
      isActive: user.isActive,
      createdAt: user.createdAt,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to create user";
    res.status(500).json({ error: msg });
  }
});

router.patch("/admin/users/:userId", ...agencyOnly, async (req, res) => {
  try {
    const userId = parseInt(String(req.params.userId));
    const updates: Record<string, unknown> = {};
    const body = req.body as Record<string, unknown>;

    if (body.name) updates.name = body.name;
    if (body.email) updates.email = (body.email as string).toLowerCase();
    if (body.role) updates.role = body.role;
    if (body.tenantId !== undefined) updates.tenantId = body.tenantId;
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (body.password) updates.passwordHash = await bcrypt.hash(body.password as string, 10);
    updates.updatedAt = new Date();

    // Reject patches that would leave a non-admin user without a
    // tenant. We need the resulting (role, tenantId) pair, so peek at
    // the current row whenever either field is changing.
    if (body.role !== undefined || body.tenantId !== undefined) {
      const [existing] = await db
        .select({ role: usersTable.role, tenantId: usersTable.tenantId })
        .from(usersTable)
        .where(eq(usersTable.id, userId));
      if (!existing) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const nextRole = (body.role as string | undefined) ?? existing.role;
      const nextTenantId = body.tenantId !== undefined
        ? (body.tenantId as number | null | undefined) ?? null
        : existing.tenantId;
      const isAdminRole = nextRole === "super_admin" || nextRole === "agency_user";
      if (!isAdminRole && !nextTenantId) {
        res.status(400).json({
          error: `tenantId is required for role "${nextRole}". Only super_admin and agency_user may exist without a tenant.`,
        });
        return;
      }
    }

    const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, userId)).returning();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
      isActive: user.isActive,
      createdAt: user.createdAt,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to update user";
    res.status(500).json({ error: msg });
  }
});

router.delete("/admin/users/:userId", ...agencyOnly, async (req, res) => {
  try {
    const userId = parseInt(String(req.params.userId));
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ error: "Invalid user ID" });
      return;
    }
    if (userId === req.session.userId) {
      res.status(400).json({ error: "Cannot delete your own account" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    try {
      await db.delete(usersTable).where(eq(usersTable.id, userId));
    } catch (dbError: unknown) {
      const msg = dbError instanceof Error ? dbError.message : "";
      if (msg.includes("foreign key") || msg.includes("violates")) {
        res.status(409).json({ error: "Cannot delete this user because they have associated records. Deactivate the user instead." });
        return;
      }
      throw dbError;
    }

    await pool.query(
      `DELETE FROM session WHERE (sess::jsonb->>'userId')::int = $1`,
      [userId]
    );

    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to delete user";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/dashboard-stats", ...agencyOnly, async (req, res) => {
  try {
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));

    const tenantStats = [];
    let totalAgencySpend = 0;
    let totalAgencyLeads = 0;
    let totalAgencyRevenue = 0;
    let totalAgencyBookedLeads = 0;

    for (const tenant of tenants) {
      const leadConditions = [eq(leadsTable.tenantId, tenant.id)];
      const jobConditions = [eq(jobsTable.tenantId, tenant.id)];

      if (startDate) {
        leadConditions.push(gte(leadsTable.createdAt, new Date(startDate)));
        jobConditions.push(gte(jobsTable.createdAt, new Date(startDate)));
      }
      if (endDate) {
        leadConditions.push(lte(leadsTable.createdAt, new Date(endDate)));
        jobConditions.push(lte(jobsTable.createdAt, new Date(endDate)));
      }

      const leads = await db.select().from(leadsTable).where(and(...leadConditions));
      const jobs = await db.select().from(jobsTable).where(and(...jobConditions));

      const campaigns = await db.select().from(campaignsTable).where(eq(campaignsTable.tenantId, tenant.id));
      const campaignIds = campaigns.map(c => c.id);

      let mtdSpend = 0;
      if (campaignIds.length > 0) {
        const spendConditions = [
          sql`${campaignDailyStatsTable.campaignId} IN (${sql.join(campaignIds.map(id => sql`${id}`), sql`,`)})`
        ];
        if (startDate) spendConditions.push(gte(campaignDailyStatsTable.date, startDate));
        if (endDate) spendConditions.push(lte(campaignDailyStatsTable.date, endDate));

        const [spendResult] = await db.select({
          total: sql<number>`COALESCE(SUM(${campaignDailyStatsTable.spend}), 0)`
        }).from(campaignDailyStatsTable).where(and(...spendConditions));
        mtdSpend = Number(spendResult?.total || 0);
      }

      const totalLeads = leads.length;
      const bookedLeads = leads.filter(l => l.status === "booked" || l.status === "sold").length;
      const soldLeads = leads.filter(l => l.status === "sold").length;
      const mtdRevenue = jobs.filter(j => j.status === "completed").reduce((s, j) => s + (j.revenue || 0), 0);
      const cpl = totalLeads > 0 ? Math.round((mtdSpend / totalLeads) * 100) / 100 : 0;
      const bookingRate = totalLeads > 0 ? Math.round((bookedLeads / totalLeads) * 100 * 10) / 10 : 0;
      const closeRate = bookedLeads > 0 ? Math.round((soldLeads / bookedLeads) * 100 * 10) / 10 : 0;
      const roas = mtdSpend > 0 ? Math.round((mtdRevenue / mtdSpend) * 100) / 100 : 0;

      const now = new Date();
      const dayOfMonth = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const projectedSpend = dayOfMonth > 0 ? Math.round((mtdSpend / dayOfMonth) * daysInMonth) : 0;

      const monthlyBudget = 15000;

      tenantStats.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        mtdSpend: Math.round(mtdSpend * 100) / 100,
        mtdRevenue: Math.round(mtdRevenue * 100) / 100,
        projectedSpend,
        monthlyBudget,
        cpl,
        bookingRate,
        closeRate,
        roas,
        totalLeads,
        bookedLeads,
        soldLeads,
      });

      totalAgencySpend += mtdSpend;
      totalAgencyLeads += totalLeads;
      totalAgencyRevenue += mtdRevenue;
      totalAgencyBookedLeads += bookedLeads;
    }

    const agencyAvgCpl = totalAgencyLeads > 0 ? Math.round((totalAgencySpend / totalAgencyLeads) * 100) / 100 : 0;
    const agencyAvgRoas = totalAgencySpend > 0 ? Math.round((totalAgencyRevenue / totalAgencySpend) * 100) / 100 : 0;
    const agencyAvgBookingRate = totalAgencyLeads > 0 ? Math.round((totalAgencyBookedLeads / totalAgencyLeads) * 100 * 10) / 10 : 0;

    res.json({
      tenants: tenantStats,
      agencyAverages: {
        cpl: agencyAvgCpl,
        roas: agencyAvgRoas,
        bookingRate: agencyAvgBookingRate,
        totalSpend: Math.round(totalAgencySpend * 100) / 100,
        totalRevenue: Math.round(totalAgencyRevenue * 100) / 100,
        totalLeads: totalAgencyLeads,
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to get dashboard stats";
    res.status(500).json({ error: msg });
  }
});

async function computeTenantMetrics(tenantId: number, startDate?: string, endDate?: string) {
  const leadConditions = [eq(leadsTable.tenantId, tenantId)];
  const jobConditions = [eq(jobsTable.tenantId, tenantId)];

  if (startDate) {
    leadConditions.push(gte(leadsTable.createdAt, new Date(startDate + "T00:00:00.000Z")));
    jobConditions.push(gte(jobsTable.createdAt, new Date(startDate + "T00:00:00.000Z")));
  }
  if (endDate) {
    leadConditions.push(lte(leadsTable.createdAt, new Date(endDate + "T23:59:59.999Z")));
    jobConditions.push(lte(jobsTable.createdAt, new Date(endDate + "T23:59:59.999Z")));
  }

  const campaigns = await db.select().from(campaignsTable).where(eq(campaignsTable.tenantId, tenantId));
  const campaignIds = campaigns.map(c => c.id);

  let mtdSpend = 0;
  if (campaignIds.length > 0) {
    const spendConds = [
      sql`${campaignDailyStatsTable.campaignId} IN (${sql.join(campaignIds.map(id => sql`${id}`), sql`,`)})`
    ];
    if (startDate) spendConds.push(gte(campaignDailyStatsTable.date, startDate));
    if (endDate) spendConds.push(lte(campaignDailyStatsTable.date, endDate));

    const [spendResult] = await db.select({
      total: sql<number>`COALESCE(SUM(${campaignDailyStatsTable.spend}), 0)`
    }).from(campaignDailyStatsTable).where(and(...spendConds));
    mtdSpend = Number(spendResult?.total || 0);
  }

  const [leads, jobs] = await Promise.all([
    db.select().from(leadsTable).where(and(...leadConditions)),
    db.select().from(jobsTable).where(and(...jobConditions)),
  ]);

  const totalLeads = leads.length;
  const bookedLeads = leads.filter(l => l.status === "booked" || l.status === "sold").length;
  const soldLeads = leads.filter(l => l.status === "sold").length;
  const revenue = jobs.filter(j => j.status === "completed").reduce((s, j) => s + (j.revenue || 0), 0);

  return {
    totalLeads,
    bookedLeads,
    soldLeads,
    revenue: Math.round(revenue * 100) / 100,
    spend: Math.round(mtdSpend * 100) / 100,
    closeRate: bookedLeads > 0 ? Math.round((soldLeads / bookedLeads) * 100 * 10) / 10 : 0,
    bookingRate: totalLeads > 0 ? Math.round((bookedLeads / totalLeads) * 100 * 10) / 10 : 0,
    cpl: totalLeads > 0 ? Math.round((mtdSpend / totalLeads) * 100) / 100 : 0,
    roas: mtdSpend > 0 ? Math.round((revenue / mtdSpend) * 100) / 100 : 0,
  };
}

router.get("/admin/leaderboard", requireAuth, async (req, res) => {
  try {
    if (req.session.userRole === "client_user") {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const metric = (req.query.metric as string) || "closeRate";
    const validMetrics = ["closeRate", "revenue", "cpl", "bookingRate"];
    if (!validMetrics.includes(metric)) {
      res.status(400).json({ error: `metric must be one of: ${validMetrics.join(", ")}` });
      return;
    }

    const role = req.session.userRole;
    const isAgency = role === "super_admin" || role === "agency_user";
    let forceAnonymize = false;

    if (!isAgency) {
      const callerTenantId = req.session.tenantId;
      if (!callerTenantId) {
        res.status(403).json({ error: "No tenant associated with user" });
        return;
      }
      const [callerTenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, callerTenantId));
      const lbConfig = (callerTenant?.leaderboardConfig || {}) as Record<string, unknown>;
      if (!lbConfig.visible) {
        res.status(403).json({ error: "Leaderboard is not enabled for your account" });
        return;
      }
      if (lbConfig.displayMode !== "named") {
        forceAnonymize = true;
      }
    }

    const now = new Date();
    const currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentEnd = now;
    const prevEnd = new Date(currentStart.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getFullYear(), prevEnd.getMonth(), 1);

    const startDate = currentStart.toISOString().split("T")[0];
    const endDate = currentEnd.toISOString().split("T")[0];
    const prevStartDate = prevStart.toISOString().split("T")[0];
    const prevEndDate = prevEnd.toISOString().split("T")[0];

    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));

    const entries = await Promise.all(tenants.map(async (tenant) => {
      const [current, previous] = await Promise.all([
        computeTenantMetrics(tenant.id, startDate, endDate),
        computeTenantMetrics(tenant.id, prevStartDate, prevEndDate),
      ]);

      const currentVal = current[metric as keyof typeof current] as number;
      const previousVal = previous[metric as keyof typeof previous] as number;
      const trend = previousVal > 0
        ? Math.round(((currentVal - previousVal) / previousVal) * 100 * 10) / 10
        : currentVal > 0 ? 100 : 0;

      const purchases = await db.select({
        itemTitle: trainingItemsTable.title,
        itemCategory: trainingItemsTable.category,
        pricePaid: trainingPurchasesTable.pricePaid,
        purchasedAt: trainingPurchasesTable.purchasedAt,
      })
        .from(trainingPurchasesTable)
        .innerJoin(trainingItemsTable, eq(trainingPurchasesTable.trainingItemId, trainingItemsTable.id))
        .where(eq(trainingPurchasesTable.tenantId, tenant.id));

      return {
        tenantId: tenant.id,
        tenantName: tenant.name,
        metricValue: currentVal,
        previousValue: previousVal,
        trend,
        closeRate: current.closeRate,
        revenue: current.revenue,
        cpl: current.cpl,
        bookingRate: current.bookingRate,
        roas: current.roas,
        totalLeads: current.totalLeads,
        spend: current.spend,
        products: purchases.map(p => ({
          name: p.itemTitle,
          category: p.itemCategory,
          pricePaid: p.pricePaid,
          purchasedAt: p.purchasedAt,
        })),
      };
    }));

    const higherIsBetter = metric !== "cpl";
    entries.sort((a, b) => higherIsBetter ? b.metricValue - a.metricValue : a.metricValue - b.metricValue);

    const ranked = entries.map((e, i) => ({ ...e, rank: i + 1 }));

    const values = ranked.map(e => e.metricValue);
    const agencyAverage = values.length > 0 ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : 0;
    const stdDev = values.length > 1
      ? Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - agencyAverage, 2), 0) / values.length)
      : 0;

    const flagged = ranked.map(e => {
      const deviation = Math.abs(e.metricValue - agencyAverage);
      const isOutlier = stdDev > 0 && deviation > stdDev * 1.5;
      const direction = higherIsBetter
        ? (e.metricValue < agencyAverage ? "underperforming" : "outperforming")
        : (e.metricValue > agencyAverage ? "underperforming" : "outperforming");
      return { ...e, isOutlier, outlierDirection: isOutlier ? direction : null };
    });

    const callerTenantId = req.session.tenantId;
    const finalRankings = forceAnonymize
      ? flagged.map((e, i) => ({
          ...e,
          tenantName: e.tenantId === callerTenantId ? e.tenantName : `Client ${String.fromCharCode(65 + i)}`,
          isOwnTenant: e.tenantId === callerTenantId,
        }))
      : flagged.map(e => ({ ...e, isOwnTenant: !isAgency && e.tenantId === callerTenantId }));

    res.json({
      metric,
      period: { start: startDate, end: endDate },
      previousPeriod: { start: prevStartDate, end: prevEndDate },
      agencyAverage,
      rankings: finalRankings,
      forceAnonymized: forceAnonymize,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to get leaderboard";
    res.status(500).json({ error: msg });
  }
});

/**
 * Backfill creative metadata (thumbnail, headline, primary text) for ads that
 * were synced before the new `meta_ads.creative_*` columns were captured.
 * Safe to re-run; only touches rows missing `creative_thumbnail_url`.
 */
router.post("/admin/meta/:tenantId/backfill-creatives", ...agencyOnly, async (req, res) => {
  try {
    const tenantId = parseInt(String(req.params.tenantId), 10);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      res.status(400).json({ error: "Invalid tenant ID" });
      return;
    }
    const body = (req.body ?? {}) as { delayMs?: unknown; maxCreatives?: unknown };
    const delayMs = typeof body.delayMs === "number" && body.delayMs >= 0 ? body.delayMs : undefined;
    const maxCreatives = typeof body.maxCreatives === "number" && body.maxCreatives > 0 ? body.maxCreatives : undefined;

    const result = await backfillMetaAdCreatives(tenantId, { delayMs, maxCreatives });
    if (result.error && result.scanned === 0 && result.updated === 0) {
      res.status(409).json(result);
      return;
    }
    res.json(result);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to backfill Meta creatives";
    res.status(500).json({ error: msg });
  }
});

export default router;
