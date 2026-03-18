import { db, trainingItemsTable, trainingEmailLogsTable, trainingDismissalsTable, tenantsTable, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable, usersTable } from "@workspace/db";
import { eq, and, sql, gte, lte, inArray } from "drizzle-orm";

async function computeTenantMetrics(tenantId: number) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const startDate = thirtyDaysAgo.toISOString().split("T")[0];
  const endDate = now.toISOString().split("T")[0];

  const [leads, jobs, tenantCampaigns] = await Promise.all([
    db.select().from(leadsTable).where(
      and(eq(leadsTable.tenantId, tenantId), gte(leadsTable.createdAt, thirtyDaysAgo))
    ),
    db.select().from(jobsTable).where(
      and(eq(jobsTable.tenantId, tenantId), gte(jobsTable.createdAt, thirtyDaysAgo))
    ),
    db.select({ id: campaignsTable.id }).from(campaignsTable).where(eq(campaignsTable.tenantId, tenantId)),
  ]);

  const campaignIds = tenantCampaigns.map(c => c.id);
  let totalSpend = 0;
  if (campaignIds.length > 0) {
    const [spendResult] = await db.select({
      total: sql<number>`COALESCE(SUM(${campaignDailyStatsTable.spend}), 0)`
    }).from(campaignDailyStatsTable).where(
      and(
        inArray(campaignDailyStatsTable.campaignId, campaignIds),
        gte(campaignDailyStatsTable.date, startDate),
        lte(campaignDailyStatsTable.date, endDate)
      )
    );
    totalSpend = Number(spendResult?.total || 0);
  }

  const totalLeads = leads.length;
  const bookedLeads = leads.filter(l => l.status === "booked" || l.status === "sold").length;
  const soldLeads = leads.filter(l => l.status === "sold").length;
  const totalRevenue = jobs.filter(j => j.status === "completed").reduce((s, j) => s + (j.revenue || 0), 0);

  return {
    booking_rate: totalLeads > 0 ? (bookedLeads / totalLeads) * 100 : 0,
    close_rate: bookedLeads > 0 ? (soldLeads / bookedLeads) * 100 : 0,
    cpl: totalLeads > 0 ? totalSpend / totalLeads : 0,
    roas: totalSpend > 0 ? totalRevenue / totalSpend : 0,
    avg_sale_value: soldLeads > 0 ? totalRevenue / soldLeads : 0,
  };
}

async function sendTrainingAlertEmail(tenantName: string, ownerEmail: string, metric: string, value: number, threshold: number, trainingTitle: string): Promise<void> {
  console.log(`[Training Alert Email] To: ${ownerEmail} | Tenant: ${tenantName} | ${metric} = ${value} (threshold: ${threshold}) | Recommended: "${trainingTitle}"`);
}

export async function runTrainingAlertCheck(): Promise<{ alertsGenerated: number }> {
  console.log("[Training Scheduler] Running automated training alert check...");

  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
  const items = await db.select().from(trainingItemsTable).where(
    and(eq(trainingItemsTable.isActive, true), sql`${trainingItemsTable.metricTrigger} IS NOT NULL`)
  );

  let alertsGenerated = 0;

  for (const tenant of tenants) {
    const metrics = await computeTenantMetrics(tenant.id);

    const [owner] = await db.select({ email: usersTable.email })
      .from(usersTable)
      .where(and(eq(usersTable.tenantId, tenant.id), eq(usersTable.role, "client_admin")));

    const ownerEmail = owner?.email || `admin@${tenant.name.toLowerCase().replace(/\s+/g, "")}.com`;

    for (const item of items) {
      if (!item.metricTrigger || item.thresholdValue == null) continue;

      const metricValue = metrics[item.metricTrigger as keyof typeof metrics];
      if (metricValue === undefined) continue;

      const direction = item.thresholdDirection || "below";
      const triggered = direction === "below" ? metricValue < item.thresholdValue : metricValue > item.thresholdValue;

      if (triggered) {
        const recentLog = await db.select().from(trainingEmailLogsTable).where(
          and(
            eq(trainingEmailLogsTable.tenantId, tenant.id),
            eq(trainingEmailLogsTable.trainingItemId, item.id),
            gte(trainingEmailLogsTable.sentAt, new Date(Date.now() - 7 * 86400000))
          )
        );

        if (recentLog.length === 0) {
          const roundedValue = Math.round(metricValue * 100) / 100;

          await sendTrainingAlertEmail(
            tenant.name,
            ownerEmail,
            item.metricTrigger,
            roundedValue,
            item.thresholdValue,
            item.title
          );

          await db.insert(trainingEmailLogsTable).values({
            tenantId: tenant.id,
            trainingItemId: item.id,
            metricTrigger: item.metricTrigger,
            metricValue: roundedValue,
            thresholdValue: item.thresholdValue,
          });

          alertsGenerated++;
        }
      }
    }
  }

  console.log(`[Training Scheduler] Alert check complete: ${alertsGenerated} alert(s) generated.`);
  return { alertsGenerated };
}

let trainingInterval: ReturnType<typeof setInterval> | null = null;

export function startTrainingAlertScheduler(intervalHours = 6): void {
  const intervalMs = intervalHours * 3600000;

  console.log(`[Training Scheduler] Starting automated training alert scheduler (every ${intervalHours}h)`);

  runTrainingAlertCheck().catch(err =>
    console.error("[Training Scheduler] Initial check failed:", err)
  );

  trainingInterval = setInterval(() => {
    runTrainingAlertCheck().catch(err =>
      console.error("[Training Scheduler] Scheduled check failed:", err)
    );
  }, intervalMs);
}

export function stopTrainingAlertScheduler(): void {
  if (trainingInterval) {
    clearInterval(trainingInterval);
    trainingInterval = null;
    console.log("[Training Scheduler] Stopped.");
  }
}
