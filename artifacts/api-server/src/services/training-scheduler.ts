import nodemailer from "nodemailer";
import { db, trainingItemsTable, trainingEmailLogsTable, tenantsTable, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable, usersTable } from "@workspace/db";
import { eq, and, sql, gte, lte, inArray } from "drizzle-orm";

const METRIC_LABELS: Record<string, string> = {
  booking_rate: "Booking Rate",
  close_rate: "Close Rate",
  cpl: "Cost Per Lead",
  roas: "ROAS",
  avg_sale_value: "Avg Sale Value",
};

const METRIC_FORMATS: Record<string, (v: number) => string> = {
  booking_rate: v => `${v.toFixed(1)}%`,
  close_rate: v => `${v.toFixed(1)}%`,
  cpl: v => `$${v.toFixed(2)}`,
  roas: v => `${v.toFixed(1)}x`,
  avg_sale_value: v => `$${v.toFixed(0)}`,
};

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

export async function computeTenantMetrics(tenantId: number) {
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

interface AlertEmailParams {
  tenantName: string;
  ownerEmail: string;
  metric: string;
  value: number;
  threshold: number;
  direction: string;
  trainingTitle: string;
  trainingDescription: string;
  trainingUrl: string | null;
  trainingContentType: string;
  trainingPrice: number | null;
}

async function sendTrainingAlertEmail(params: AlertEmailParams): Promise<boolean> {
  const { tenantName, ownerEmail, metric, value, threshold, direction, trainingTitle, trainingDescription, trainingUrl, trainingContentType, trainingPrice } = params;

  const metricLabel = METRIC_LABELS[metric] || metric;
  const formatter = METRIC_FORMATS[metric] || ((v: number) => String(v));
  const formattedValue = formatter(value);
  const formattedThreshold = formatter(threshold);

  const ctaText = trainingContentType === "paid_course"
    ? `Enroll Now${trainingPrice ? ` — $${trainingPrice}` : ""}`
    : "Read This Free Tip";
  const ctaLink = trainingUrl || "#";

  const subject = `⚠️ ${metricLabel} Alert for ${tenantName} — Action Recommended`;

  const htmlBody = `
    <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; background: #0A0F1F; color: #ffffff; padding: 32px; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 style="font-size: 24px; font-weight: 800; color: #ffffff; margin: 0;">Optics</h1>
        <p style="color: #9ca3af; font-size: 12px; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0;">Performance Alert</p>
      </div>

      <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.2); border-radius: 8px; padding: 16px; margin-bottom: 24px;">
        <p style="color: #f59e0b; font-size: 14px; font-weight: 600; margin: 0 0 8px;">
          ⚠️ ${metricLabel} is ${direction} threshold
        </p>
        <p style="color: #d1d5db; font-size: 13px; margin: 0;">
          <strong>${tenantName}</strong>'s ${metricLabel} is currently <strong>${formattedValue}</strong>
          (threshold: ${formattedThreshold}).
        </p>
      </div>

      <div style="background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <h2 style="font-size: 16px; color: #ffffff; margin: 0 0 8px;">
          ${trainingContentType === "paid_course" ? "🎓" : "💡"} Recommended: ${trainingTitle}
        </h2>
        <p style="color: #9ca3af; font-size: 13px; line-height: 1.6; margin: 0 0 16px;">
          ${trainingDescription}
        </p>
        ${trainingUrl ? `
        <a href="${ctaLink}" style="display: inline-block; background: #F20505; color: #ffffff; text-decoration: none; padding: 10px 24px; border-radius: 8px; font-size: 14px; font-weight: 600;">
          ${ctaText}
        </a>` : ""}
      </div>

      <p style="color: #6b7280; font-size: 11px; text-align: center; margin: 0;">
        This alert was sent by Optics. You will not receive another alert for this metric within 7 days.
      </p>
    </div>
  `;

  const textBody = `
${metricLabel} Alert for ${tenantName}

Your ${metricLabel} is currently ${formattedValue} (threshold: ${formattedThreshold}).

Recommended Training: ${trainingTitle}
${trainingDescription}
${trainingUrl ? `\nAccess here: ${trainingUrl}` : ""}

— Optics
  `.trim();

  const transporter = createTransporter();
  const fromEmail = process.env.SMTP_FROM || "alerts@marketingos.io";

  if (transporter) {
    try {
      await transporter.sendMail({
        from: `"Optics" <${fromEmail}>`,
        to: ownerEmail,
        subject,
        text: textBody,
        html: htmlBody,
      });
      console.log(`[Training Alert] Email sent to ${ownerEmail} for ${tenantName} (${metric})`);
      return true;
    } catch (err) {
      console.error(`[Training Alert] Failed to send email to ${ownerEmail}:`, err);
      return false;
    }
  }

  console.log(`[Training Alert] SMTP not configured — logging email instead`);
  console.log(`[Training Alert] To: ${ownerEmail} | Subject: ${subject}`);
  console.log(`[Training Alert] Body: ${textBody}`);
  return true;
}

export interface TrainingAlert {
  tenantId: number;
  tenantName: string;
  metric: string;
  value: number;
  threshold: number;
  trainingItemId: number;
  trainingTitle: string;
  trainingUrl: string | null;
  emailSent: boolean;
}

export async function runTrainingAlertCheck(): Promise<{ alertsGenerated: number; alerts: TrainingAlert[] }> {
  console.log("[Training Scheduler] Running automated training alert check...");

  const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
  const items = await db.select().from(trainingItemsTable).where(
    and(eq(trainingItemsTable.isActive, true), sql`${trainingItemsTable.metricTrigger} IS NOT NULL`)
  );

  const alerts: TrainingAlert[] = [];

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

          const emailSent = await sendTrainingAlertEmail({
            tenantName: tenant.name,
            ownerEmail,
            metric: item.metricTrigger,
            value: roundedValue,
            threshold: item.thresholdValue,
            direction,
            trainingTitle: item.title,
            trainingDescription: item.description,
            trainingUrl: item.url,
            trainingContentType: item.contentType,
            trainingPrice: item.price,
          });

          if (emailSent) {
            await db.insert(trainingEmailLogsTable).values({
              tenantId: tenant.id,
              trainingItemId: item.id,
              metricTrigger: item.metricTrigger,
              metricValue: roundedValue,
              thresholdValue: item.thresholdValue,
            });
          }

          alerts.push({
            tenantId: tenant.id,
            tenantName: tenant.name,
            metric: item.metricTrigger,
            value: roundedValue,
            threshold: item.thresholdValue,
            trainingItemId: item.id,
            trainingTitle: item.title,
            trainingUrl: item.url,
            emailSent,
          });
        }
      }
    }
  }

  console.log(`[Training Scheduler] Alert check complete: ${alerts.length} alert(s) generated.`);
  return { alertsGenerated: alerts.length, alerts };
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
