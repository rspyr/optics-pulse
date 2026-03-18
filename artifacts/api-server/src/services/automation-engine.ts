import { db, automationRulesTable, automationAlertsTable, campaignsTable, campaignDailyStatsTable, tenantsTable, leadsTable, jobsTable } from "@workspace/db";
import { eq, and, gte, sql } from "drizzle-orm";

interface CampaignMetrics {
  campaignId: number;
  campaignName: string;
  tenantId: number;
  tenantName: string;
  platform: string;
  daysActive: number;
  totalSpend: number;
  totalConversions: number;
  cpl: number;
  roas: number;
}

async function getCampaignMetrics(): Promise<CampaignMetrics[]> {
  const campaigns = await db.select().from(campaignsTable).where(eq(campaignsTable.status, "active"));
  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
  const tenantMap = new Map(tenants.map(t => [t.id, t.name]));

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString().split("T")[0];

  const results: CampaignMetrics[] = [];

  for (const campaign of campaigns) {
    const stats = await db.select().from(campaignDailyStatsTable)
      .where(and(
        eq(campaignDailyStatsTable.campaignId, campaign.id),
        gte(campaignDailyStatsTable.date, thirtyDaysAgo),
      ));

    const totalSpend = stats.reduce((s, r) => s + (r.spend || 0), 0);
    const totalConversions = stats.reduce((s, r) => s + (r.conversions || 0), 0);
    const daysActive = Math.max(1, Math.ceil((now.getTime() - campaign.createdAt.getTime()) / 86400000));

    const revenueResult = await db.select({ total: sql<number>`COALESCE(SUM(revenue), 0)::real` })
      .from(jobsTable)
      .where(eq(jobsTable.tenantId, campaign.tenantId));
    const totalRevenue = revenueResult[0]?.total || 0;

    results.push({
      campaignId: campaign.id,
      campaignName: campaign.name,
      tenantId: campaign.tenantId,
      tenantName: tenantMap.get(campaign.tenantId) || "Unknown",
      platform: campaign.platform,
      daysActive,
      totalSpend: Math.round(totalSpend * 100) / 100,
      totalConversions,
      cpl: totalConversions > 0 ? Math.round((totalSpend / totalConversions) * 100) / 100 : 0,
      roas: totalSpend > 0 ? Math.round((totalRevenue / totalSpend) * 100) / 100 : 0,
    });
  }

  return results;
}

function evaluateCondition(
  conditionType: string,
  conditionValue: number,
  metrics: CampaignMetrics,
): boolean {
  switch (conditionType) {
    case "spend_below":
      return metrics.totalSpend < conditionValue;
    case "spend_above":
      return metrics.totalSpend > conditionValue;
    case "days_active_above":
      return metrics.daysActive > conditionValue;
    case "conversions_below":
      return metrics.totalConversions < conditionValue;
    case "cpl_above":
      return metrics.cpl > conditionValue && metrics.cpl > 0;
    case "roas_below":
      return metrics.roas < conditionValue && metrics.totalSpend > 0;
    default:
      return false;
  }
}

function describeAction(actionType: string, campaignName: string): string {
  switch (actionType) {
    case "send_alert":
      return `Alert sent for campaign "${campaignName}"`;
    case "flag_for_review":
      return `Campaign "${campaignName}" flagged for review`;
    case "auto_pause":
      return `Campaign "${campaignName}" flagged for auto-pause — manual review required (v1)`;
    default:
      return `Action "${actionType}" logged for campaign "${campaignName}"`;
  }
}

export async function evaluateAutomationRules(): Promise<{ alertsGenerated: number; rulesEvaluated: number }> {
  const rules = await db.select().from(automationRulesTable).where(eq(automationRulesTable.isEnabled, true));

  if (rules.length === 0) {
    return { alertsGenerated: 0, rulesEvaluated: 0 };
  }

  const campaignMetrics = await getCampaignMetrics();

  let alertsGenerated = 0;

  for (const rule of rules) {
    const applicableCampaigns = campaignMetrics.filter(m => {
      if (rule.tenantId && m.tenantId !== rule.tenantId) return false;
      if (rule.platform && m.platform !== rule.platform) return false;
      return true;
    });

    for (const metrics of applicableCampaigns) {
      const triggered = evaluateCondition(rule.conditionType, rule.conditionValue, metrics);
      if (!triggered) continue;

      const oneDayAgo = new Date(Date.now() - 86400000);
      const recentAlerts = await db.select().from(automationAlertsTable)
        .where(and(
          eq(automationAlertsTable.ruleId, rule.id),
          eq(automationAlertsTable.campaignId!, metrics.campaignId),
          gte(automationAlertsTable.createdAt, oneDayAgo),
        ));

      if (recentAlerts.length > 0) continue;

      const actionTaken = describeAction(rule.actionType, metrics.campaignName);

      await db.insert(automationAlertsTable).values({
        ruleId: rule.id,
        tenantId: metrics.tenantId,
        campaignId: metrics.campaignId,
        campaignName: metrics.campaignName,
        tenantName: metrics.tenantName,
        conditionType: rule.conditionType,
        conditionValue: rule.conditionValue,
        actualValue: getActualValue(rule.conditionType, metrics),
        actionType: rule.actionType,
        actionTaken,
      });

      alertsGenerated++;
    }
  }

  return { alertsGenerated, rulesEvaluated: rules.length };
}

function getActualValue(conditionType: string, metrics: CampaignMetrics): number {
  switch (conditionType) {
    case "spend_below":
    case "spend_above":
      return metrics.totalSpend;
    case "days_active_above":
      return metrics.daysActive;
    case "conversions_below":
      return metrics.totalConversions;
    case "cpl_above":
      return metrics.cpl;
    case "roas_below":
      return metrics.roas;
    default:
      return 0;
  }
}

export function startAutomationScheduler() {
  console.log("[Automation] Starting rule evaluation scheduler (every 60 min)");

  evaluateAutomationRules().then(result => {
    console.log(`[Automation] Initial evaluation complete: ${result.alertsGenerated} alert(s), ${result.rulesEvaluated} rule(s) evaluated.`);
  }).catch(err => {
    console.error("[Automation] Initial evaluation failed:", err);
  });

  setInterval(async () => {
    try {
      console.log("[Automation] Running scheduled rule evaluation...");
      const result = await evaluateAutomationRules();
      console.log(`[Automation] Evaluation complete: ${result.alertsGenerated} alert(s), ${result.rulesEvaluated} rule(s) evaluated.`);
    } catch (err) {
      console.error("[Automation] Scheduled evaluation failed:", err);
    }
  }, 60 * 60 * 1000);
}
