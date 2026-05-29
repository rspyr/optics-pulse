import nodemailer from "nodemailer";
import { db, tenantsTable, usersTable, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable } from "@workspace/db";
import { eq, and, gte, inArray, sql } from "drizzle-orm";
import { createGuardedRunner } from "../lib/reentrancy-guard";

interface AlertResult {
  tenantId: number;
  tenantName: string;
  alertType: string;
  message: string;
  emailSent: boolean;
}

function createTransporter() {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpUser || !smtpPass) return null;

  return nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: (Number(process.env.SMTP_PORT) || 587) === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });
}

async function getTenantMetrics(tenantId: number) {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);

  const [recentLeads, previousLeads] = await Promise.all([
    db.select().from(leadsTable).where(and(eq(leadsTable.tenantId, tenantId), gte(leadsTable.createdAt, sevenDaysAgo))),
    db.select().from(leadsTable).where(and(eq(leadsTable.tenantId, tenantId), gte(leadsTable.createdAt, fourteenDaysAgo))),
  ]);

  const recentJobs = await db.select().from(jobsTable).where(and(eq(jobsTable.tenantId, tenantId), gte(jobsTable.createdAt, sevenDaysAgo)));

  const campaignIds = (await db.select({ id: campaignsTable.id }).from(campaignsTable).where(eq(campaignsTable.tenantId, tenantId))).map(c => c.id);

  let recentSpend = 0;
  let previousSpend = 0;
  if (campaignIds.length > 0) {
    const recentDate = sevenDaysAgo.toISOString().split("T")[0];
    const previousDate = fourteenDaysAgo.toISOString().split("T")[0];
    const [rs] = await db.select({ total: sql<number>`COALESCE(SUM(spend), 0)::real` })
      .from(campaignDailyStatsTable)
      .where(and(inArray(campaignDailyStatsTable.campaignId, campaignIds), gte(campaignDailyStatsTable.date, recentDate)));
    recentSpend = Number(rs?.total || 0);

    const [ps] = await db.select({ total: sql<number>`COALESCE(SUM(spend), 0)::real` })
      .from(campaignDailyStatsTable)
      .where(and(inArray(campaignDailyStatsTable.campaignId, campaignIds), gte(campaignDailyStatsTable.date, previousDate)));
    previousSpend = Number(ps?.total || 0) - recentSpend;
  }

  const prev7dayLeads = previousLeads.filter(l => new Date(l.createdAt) < sevenDaysAgo).length;

  const recentBookedLeads = recentLeads.filter(l => l.status === "booked" || l.status === "sold").length;
  const recentRevenue = recentJobs.filter(j => j.status === "completed").reduce((s, j) => s + (j.revenue || 0), 0);

  return {
    recentLeadCount: recentLeads.length,
    previousLeadCount: prev7dayLeads,
    recentBookingRate: recentLeads.length > 0 ? (recentBookedLeads / recentLeads.length) * 100 : 0,
    recentRevenue,
    recentSpend,
    previousSpend,
    recentROAS: recentSpend > 0 ? recentRevenue / recentSpend : 0,
  };
}

async function sendClientAlertEmail(
  to: string,
  tenantName: string,
  alerts: { type: string; message: string }[],
  senderOverride?: string,
): Promise<boolean> {
  const transporter = createTransporter();
  if (!transporter) {
    console.log("[ClientAlerts] SMTP not configured — skipping email");
    return false;
  }

  const fromEmail = senderOverride || process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@hvaclaunch.com";

  const alertRows = alerts.map(a => `
    <tr>
      <td style="padding:12px;border-bottom:1px solid #1E293B;">
        <span style="color:#F20505;font-weight:600;">${a.type}</span>
      </td>
      <td style="padding:12px;border-bottom:1px solid #1E293B;color:#E2E8F0;">
        ${a.message}
      </td>
    </tr>
  `).join("");

  try {
    await transporter.sendMail({
      from: fromEmail,
      to,
      subject: `[Optics] Weekly Performance Alert — ${tenantName}`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0A0F1F;color:#fff;padding:32px;border-radius:12px;">
          <div style="text-align:center;margin-bottom:24px;">
            <span style="display:inline-block;font-size:20px;font-weight:800;color:#fff;">Optics</span>
          </div>
          <h2 style="color:#fff;margin:0 0 8px;font-size:20px;">Performance Alert for ${tenantName}</h2>
          <p style="color:#879199;margin:0 0 24px;font-size:14px;">Your weekly marketing performance summary shows items needing attention:</p>
          <table style="width:100%;border-collapse:collapse;">${alertRows}</table>
          <p style="margin-top:24px;color:#879199;font-size:12px;">Log in to Optics for full details and recommendations.</p>
          <p style="color:#4B5563;font-size:11px;margin-top:16px;">This is an automated alert from Optics by HVAC Launch.</p>
        </div>
      `,
    });
    return true;
  } catch (err) {
    console.error("[ClientAlerts] Email failed:", err);
    return false;
  }
}

interface TenantAlertConfig {
  enabled?: boolean;
  recipients?: string[];
  agencySenderEmail?: string;
  leadDropEnabled?: boolean;
  leadDropThreshold?: number;
  bookingRateEnabled?: boolean;
  bookingRateThreshold?: number;
  roasEnabled?: boolean;
  roasThreshold?: number;
  spendSpikeEnabled?: boolean;
  spendSpikeThreshold?: number;
}

function getAlertConfig(tenant: { alertConfig: unknown }): TenantAlertConfig {
  if (tenant.alertConfig && typeof tenant.alertConfig === "object") {
    return tenant.alertConfig as TenantAlertConfig;
  }
  return {};
}

export async function runClientAlertCheck(): Promise<AlertResult[]> {
  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
  const results: AlertResult[] = [];

  for (const tenant of tenants) {
    const cfg = getAlertConfig(tenant);
    if (cfg.enabled === false) continue;

    const leadDropEnabled = cfg.leadDropEnabled !== false;
    const bookingRateEnabled = cfg.bookingRateEnabled !== false;
    const roasEnabled = cfg.roasEnabled !== false;
    const spendSpikeEnabled = cfg.spendSpikeEnabled !== false;

    const leadDropThreshold = cfg.leadDropThreshold ?? 30;
    const bookingRateThreshold = cfg.bookingRateThreshold ?? 30;
    const roasThreshold = cfg.roasThreshold ?? 3;
    const spendSpikeThreshold = cfg.spendSpikeThreshold ?? 50;

    const metrics = await getTenantMetrics(tenant.id);
    const alerts: { type: string; message: string }[] = [];

    if (leadDropEnabled && metrics.previousLeadCount > 0) {
      const leadDrop = ((metrics.previousLeadCount - metrics.recentLeadCount) / metrics.previousLeadCount) * 100;
      if (leadDrop >= leadDropThreshold) {
        alerts.push({
          type: "Lead Volume Drop",
          message: `Lead volume dropped ${leadDrop.toFixed(0)}% this week (${metrics.recentLeadCount} vs ${metrics.previousLeadCount} prior week).`,
        });
      }
    }

    if (bookingRateEnabled && metrics.recentBookingRate < bookingRateThreshold && metrics.recentLeadCount > 5) {
      alerts.push({
        type: "Low Booking Rate",
        message: `Booking rate is ${metrics.recentBookingRate.toFixed(1)}%, which is below the ${bookingRateThreshold}% threshold.`,
      });
    }

    if (roasEnabled && metrics.recentROAS > 0 && metrics.recentROAS < roasThreshold) {
      alerts.push({
        type: "Low ROAS",
        message: `Return on Ad Spend is ${metrics.recentROAS.toFixed(2)}x, below the ${roasThreshold}x target.`,
      });
    }

    if (spendSpikeEnabled && metrics.previousSpend > 0) {
      const spendIncrease = ((metrics.recentSpend - metrics.previousSpend) / metrics.previousSpend) * 100;
      if (spendIncrease > spendSpikeThreshold) {
        alerts.push({
          type: "Spend Spike",
          message: `Ad spend increased ${spendIncrease.toFixed(0)}% week-over-week ($${metrics.recentSpend.toFixed(0)} vs $${metrics.previousSpend.toFixed(0)}).`,
        });
      }
    }

    if (alerts.length > 0) {
      const recipientEmails: string[] = [];

      if (cfg.recipients && cfg.recipients.length > 0) {
        recipientEmails.push(...cfg.recipients);
      } else {
        const owners = await db.select().from(usersTable)
          .where(and(eq(usersTable.tenantId, tenant.id), eq(usersTable.role, "client_admin")));
        recipientEmails.push(...owners.map(o => o.email));
      }

      let emailSent = false;
      const senderOverride = cfg.agencySenderEmail || undefined;
      for (const email of recipientEmails) {
        const sent = await sendClientAlertEmail(email, tenant.name, alerts, senderOverride);
        if (sent) emailSent = true;
      }

      for (const alert of alerts) {
        results.push({
          tenantId: tenant.id,
          tenantName: tenant.name,
          alertType: alert.type,
          message: alert.message,
          emailSent,
        });
      }
    }
  }

  console.log(`[ClientAlerts] Check complete: ${results.length} alert(s) across ${tenants.length} tenant(s)`);
  return results;
}

export function startClientAlertScheduler() {
  console.log("[ClientAlerts] Starting weekly alert scheduler");

  const checkInterval = 24 * 60 * 60 * 1000;
  // Re-entrancy guard: a check that outlasts its interval must make the next
  // tick skip rather than stack an overlapping check.
  const runAlertSweep = createGuardedRunner("ClientAlerts", async () => {
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek !== 1) return;

    console.log("[ClientAlerts] Running weekly client alert check...");
    try {
      const results = await runClientAlertCheck();
      console.log(`[ClientAlerts] Weekly check: ${results.length} alert(s) sent`);
    } catch (err) {
      console.error("[ClientAlerts] Weekly check failed:", err);
    }
  });
  setInterval(() => {
    void runAlertSweep();
  }, checkInterval);
}
