import nodemailer from "nodemailer";
import { db, automationRulesTable, automationAlertsTable, campaignsTable, campaignDailyStatsTable, tenantsTable, jobsTable, usersTable } from "@workspace/db";
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

function createTransporter() {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (smtpHost && smtpUser && smtpPass) {
    return nodemailer.createTransport({
      host: smtpHost,
      port: Number(smtpPort) || 587,
      secure: (Number(smtpPort) || 587) === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });
  }
  return null;
}

const CONDITION_LABELS: Record<string, string> = {
  spend_below: "Spend Below",
  spend_above: "Spend Above",
  days_active_above: "Days Active Above",
  conversions_below: "Conversions Below",
  cpl_above: "CPL Above",
  roas_below: "ROAS Below",
};

async function sendAutomationAlertEmail(params: {
  ruleName: string;
  conditionLabel: string;
  conditionValue: number;
  actualValue: number;
  campaignName: string;
  tenantName: string;
  actionType: string;
}): Promise<boolean> {
  const transporter = createTransporter();
  if (!transporter) {
    console.log("[Automation] SMTP not configured — skipping email alert");
    return false;
  }

  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@hvaclaunch.com";
  const toEmail = process.env.AUTOMATION_ALERT_EMAIL || process.env.SMTP_USER;
  if (!toEmail) return false;

  const actionLabel = params.actionType === "auto_pause" ? "Auto-Pause (Manual Review Required)"
    : params.actionType === "flag_for_review" ? "Flagged for Review"
    : "Alert";

  try {
    await transporter.sendMail({
      from: fromEmail,
      to: toEmail,
      subject: `[Marketing OS] Automation Alert: ${params.ruleName}`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0A0F1F;color:#fff;padding:32px;border-radius:12px;">
          <h2 style="color:#F20505;margin:0 0 16px;">Automation Rule Triggered</h2>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#879199;">Rule</td><td style="padding:8px 0;color:#fff;font-weight:600;">${params.ruleName}</td></tr>
            <tr><td style="padding:8px 0;color:#879199;">Campaign</td><td style="padding:8px 0;color:#fff;">${params.campaignName}</td></tr>
            <tr><td style="padding:8px 0;color:#879199;">Tenant</td><td style="padding:8px 0;color:#fff;">${params.tenantName}</td></tr>
            <tr><td style="padding:8px 0;color:#879199;">Condition</td><td style="padding:8px 0;color:#F20505;">${params.conditionLabel}: ${params.actualValue} (threshold: ${params.conditionValue})</td></tr>
            <tr><td style="padding:8px 0;color:#879199;">Action</td><td style="padding:8px 0;color:#fff;">${actionLabel}</td></tr>
          </table>
          <p style="margin-top:24px;color:#879199;font-size:12px;">This is an automated alert from Marketing OS.</p>
        </div>
      `,
    });
    console.log(`[Automation] Email alert sent for rule "${params.ruleName}"`);
    return true;
  } catch (err) {
    console.error("[Automation] Email send failed:", err);
    return false;
  }
}

async function getCampaignMetrics(lookbackDays: number): Promise<CampaignMetrics[]> {
  const campaigns = await db.select().from(campaignsTable).where(eq(campaignsTable.status, "active"));
  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
  const tenantMap = new Map(tenants.map(t => [t.id, t.name]));

  const now = new Date();
  const lookbackDate = new Date(now.getTime() - lookbackDays * 86400000).toISOString().split("T")[0];

  const results: CampaignMetrics[] = [];

  for (const campaign of campaigns) {
    const stats = await db.select().from(campaignDailyStatsTable)
      .where(and(
        eq(campaignDailyStatsTable.campaignId, campaign.id),
        gte(campaignDailyStatsTable.date, lookbackDate),
      ));

    const totalSpend = stats.reduce((s, r) => s + (r.spend || 0), 0);
    const totalConversions = stats.reduce((s, r) => s + (r.conversions || 0), 0);
    const daysActive = Math.max(1, Math.ceil((now.getTime() - campaign.createdAt.getTime()) / 86400000));

    const revenueResult = await db.select({ total: sql<number>`COALESCE(SUM(revenue), 0)::real` })
      .from(jobsTable)
      .where(and(
        eq(jobsTable.tenantId, campaign.tenantId),
        gte(jobsTable.createdAt, new Date(now.getTime() - lookbackDays * 86400000)),
      ));
    const campaignRevenue = revenueResult[0]?.total || 0;

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
      roas: totalSpend > 0 ? Math.round((campaignRevenue / totalSpend) * 100) / 100 : 0,
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
      return `Alert sent (in-app + email) for campaign "${campaignName}"`;
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

  const metricsCache = new Map<number, CampaignMetrics[]>();

  let alertsGenerated = 0;

  for (const rule of rules) {
    const lookback = rule.lookbackDays || 30;
    if (!metricsCache.has(lookback)) {
      metricsCache.set(lookback, await getCampaignMetrics(lookback));
    }
    const campaignMetrics = metricsCache.get(lookback)!;

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
      const actualValue = getActualValue(rule.conditionType, metrics);

      await db.insert(automationAlertsTable).values({
        ruleId: rule.id,
        tenantId: metrics.tenantId,
        campaignId: metrics.campaignId,
        campaignName: metrics.campaignName,
        tenantName: metrics.tenantName,
        conditionType: rule.conditionType,
        conditionValue: rule.conditionValue,
        actualValue,
        actionType: rule.actionType,
        actionTaken,
      });

      if (rule.actionType === "send_alert") {
        await sendAutomationAlertEmail({
          ruleName: rule.name,
          conditionLabel: CONDITION_LABELS[rule.conditionType] || rule.conditionType,
          conditionValue: rule.conditionValue,
          actualValue,
          campaignName: metrics.campaignName,
          tenantName: metrics.tenantName,
          actionType: rule.actionType,
        });
      }

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
