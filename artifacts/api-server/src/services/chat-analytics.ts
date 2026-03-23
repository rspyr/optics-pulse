import { db, leadsTable, jobsTable, campaignsTable, campaignDailyStatsTable, attributionEventsTable, changeLogsTable } from "@workspace/db";
import { eq, and, gte, lte, sql, inArray, SQL, desc, count } from "drizzle-orm";

interface ChatContext {
  tenantId: number;
  startDate?: string;
  endDate?: string;
}

interface QueryResult {
  answer: string;
  data?: Record<string, unknown>[];
  chartType?: "bar" | "table" | "number" | "list";
  chartLabel?: string;
}

interface QueryPattern {
  patterns: RegExp[];
  handler: (ctx: ChatContext, match: RegExpMatchArray | null, question: string) => Promise<QueryResult>;
  description: string;
}

function last30Days() {
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 86400000);
  return {
    startDate: start.toISOString().split("T")[0],
    endDate: now.toISOString().split("T")[0],
  };
}

function last7Days() {
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 86400000);
  return {
    startDate: start.toISOString().split("T")[0],
    endDate: now.toISOString().split("T")[0],
  };
}

function extractDateRange(question: string): { startDate: string; endDate: string } {
  const q = question.toLowerCase();
  if (q.includes("last week") || q.includes("past week") || q.includes("this week")) return last7Days();
  if (q.includes("last 7 days") || q.includes("past 7 days")) return last7Days();
  if (q.includes("last 14 days") || q.includes("past 14 days") || q.includes("two weeks")) {
    const now = new Date();
    return { startDate: new Date(now.getTime() - 14 * 86400000).toISOString().split("T")[0], endDate: now.toISOString().split("T")[0] };
  }
  if (q.includes("last 90 days") || q.includes("past 90 days") || q.includes("quarter")) {
    const now = new Date();
    return { startDate: new Date(now.getTime() - 90 * 86400000).toISOString().split("T")[0], endDate: now.toISOString().split("T")[0] };
  }
  return last30Days();
}

async function getCampaignIdsForTenant(tenantId: number): Promise<number[]> {
  const campaigns = await db.select({ id: campaignsTable.id }).from(campaignsTable).where(eq(campaignsTable.tenantId, tenantId));
  return campaigns.map(c => c.id);
}

async function getLeadMetrics(ctx: ChatContext) {
  const conditions: SQL[] = [eq(leadsTable.tenantId, ctx.tenantId)];
  if (ctx.startDate) conditions.push(gte(leadsTable.createdAt, new Date(ctx.startDate)));
  if (ctx.endDate) conditions.push(lte(leadsTable.createdAt, new Date(ctx.endDate)));

  const leads = await db.select().from(leadsTable).where(and(...conditions));
  const total = leads.length;
  const booked = leads.filter(l => l.status === "booked" || l.status === "sold").length;
  const sold = leads.filter(l => l.status === "sold").length;

  return { total, booked, sold, leads };
}

async function getSpendMetrics(ctx: ChatContext) {
  const campaignIds = await getCampaignIdsForTenant(ctx.tenantId);
  if (campaignIds.length === 0) return { totalSpend: 0, totalClicks: 0, totalImpressions: 0, totalConversions: 0, stats: [] };

  const conditions: SQL[] = [inArray(campaignDailyStatsTable.campaignId, campaignIds)];
  if (ctx.startDate) conditions.push(gte(campaignDailyStatsTable.date, ctx.startDate));
  if (ctx.endDate) conditions.push(lte(campaignDailyStatsTable.date, ctx.endDate));

  const stats = await db.select().from(campaignDailyStatsTable).where(and(...conditions));
  const totalSpend = stats.reduce((s, r) => s + (r.spend || 0), 0);
  const totalClicks = stats.reduce((s, r) => s + (r.clicks || 0), 0);
  const totalImpressions = stats.reduce((s, r) => s + (r.impressions || 0), 0);
  const totalConversions = stats.reduce((s, r) => s + (r.conversions || 0), 0);

  return { totalSpend, totalClicks, totalImpressions, totalConversions, stats };
}

async function getRevenueMetrics(ctx: ChatContext) {
  const conditions: SQL[] = [eq(jobsTable.tenantId, ctx.tenantId), eq(jobsTable.status, "completed")];
  if (ctx.startDate) conditions.push(gte(jobsTable.completedAt, new Date(ctx.startDate)));
  if (ctx.endDate) conditions.push(lte(jobsTable.completedAt, new Date(ctx.endDate)));

  const jobs = await db.select().from(jobsTable).where(and(...conditions));
  const totalRevenue = jobs.reduce((s, j) => s + (j.revenue || 0), 0);
  const avgRevenue = jobs.length > 0 ? totalRevenue / jobs.length : 0;

  return { totalRevenue, avgRevenue, jobCount: jobs.length, jobs };
}

const queryPatterns: QueryPattern[] = [
  {
    patterns: [
      /(?:what(?:'s| is)|show|tell|how much).*(cpl|cost per lead)/i,
      /cpl/i,
    ],
    description: "Cost per lead",
    handler: async (ctx) => {
      const leadData = await getLeadMetrics(ctx);
      const spendData = await getSpendMetrics(ctx);
      const cpl = leadData.total > 0 ? spendData.totalSpend / leadData.total : 0;
      return {
        answer: `Your Cost Per Lead is **$${cpl.toFixed(2)}** based on $${spendData.totalSpend.toFixed(2)} in ad spend across ${leadData.total} leads.`,
        data: [{ metric: "CPL", value: `$${cpl.toFixed(2)}`, spend: `$${spendData.totalSpend.toFixed(2)}`, leads: leadData.total }],
        chartType: "number",
      };
    },
  },
  {
    patterns: [
      /(?:why|how come|what happened).*(cpl|cost per lead).*(go up|increase|rise|spike|jump)/i,
      /(?:why|how come|what happened).*(spend|cost).*(go up|increase|rise|spike|jump)/i,
    ],
    description: "CPL increase analysis",
    handler: async (ctx, _match, question) => {
      const currentRange = extractDateRange(question);
      const prevEnd = new Date(new Date(currentRange.startDate).getTime() - 86400000);
      const durationMs = new Date(currentRange.endDate).getTime() - new Date(currentRange.startDate).getTime();
      const prevStart = new Date(prevEnd.getTime() - durationMs);

      const currentCtx = { ...ctx, ...currentRange };
      const prevCtx = { ...ctx, startDate: prevStart.toISOString().split("T")[0], endDate: prevEnd.toISOString().split("T")[0] };

      const [currLeads, currSpend, prevLeads, prevSpend] = await Promise.all([
        getLeadMetrics(currentCtx),
        getSpendMetrics(currentCtx),
        getLeadMetrics(prevCtx),
        getSpendMetrics(prevCtx),
      ]);

      const currCPL = currLeads.total > 0 ? currSpend.totalSpend / currLeads.total : 0;
      const prevCPL = prevLeads.total > 0 ? prevSpend.totalSpend / prevLeads.total : 0;
      const cplChange = prevCPL > 0 ? ((currCPL - prevCPL) / prevCPL * 100) : 0;
      const spendChange = prevSpend.totalSpend > 0 ? ((currSpend.totalSpend - prevSpend.totalSpend) / prevSpend.totalSpend * 100) : 0;
      const leadChange = prevLeads.total > 0 ? ((currLeads.total - prevLeads.total) / prevLeads.total * 100) : 0;

      const reasons: string[] = [];
      if (spendChange > 10) reasons.push(`Ad spend increased by ${spendChange.toFixed(0)}%`);
      if (leadChange < -10) reasons.push(`Lead volume dropped by ${Math.abs(leadChange).toFixed(0)}%`);
      if (spendChange > 0 && leadChange <= 0) reasons.push("Spend went up while leads stayed flat or dropped — check campaign targeting");
      if (reasons.length === 0) reasons.push("No major single-factor change detected — this may be seasonal or due to competition");

      return {
        answer: `Your CPL moved from **$${prevCPL.toFixed(2)}** to **$${currCPL.toFixed(2)}** (${cplChange >= 0 ? "+" : ""}${cplChange.toFixed(1)}%). Here's what may be driving it:\n\n${reasons.map(r => `• ${r}`).join("\n")}`,
        data: [
          { period: "Previous", cpl: `$${prevCPL.toFixed(2)}`, spend: `$${prevSpend.totalSpend.toFixed(2)}`, leads: prevLeads.total },
          { period: "Current", cpl: `$${currCPL.toFixed(2)}`, spend: `$${currSpend.totalSpend.toFixed(2)}`, leads: currLeads.total },
        ],
        chartType: "table",
      };
    },
  },
  {
    patterns: [
      /(?:google|meta|facebook).*(spend|cost|performance|leads|stats|campaign)/i,
      /(?:show|how|list|what).*(google|meta|facebook)/i,
      /(?:meta|facebook|google)\s+campaign/i,
    ],
    description: "Platform-specific performance",
    handler: async (ctx, match) => {
      const q = match?.[0]?.toLowerCase() || "";
      const isMeta = q.includes("meta") || q.includes("facebook");
      const platformLabel = isMeta ? "Meta" : "Google Ads";

      const allCampaigns = await db.select().from(campaignsTable).where(eq(campaignsTable.tenantId, ctx.tenantId));
      const campaigns = allCampaigns.filter(c => {
        const p = c.platform.toLowerCase();
        if (isMeta) return p === "meta" || p === "facebook";
        return p === "google" || p === "google_ads";
      });

      if (campaigns.length === 0) return { answer: `No ${platformLabel} campaigns found.`, chartType: "number" as const };

      const campaignIds = campaigns.map(c => c.id);
      const conditions: SQL[] = [inArray(campaignDailyStatsTable.campaignId, campaignIds)];
      if (ctx.startDate) conditions.push(gte(campaignDailyStatsTable.date, ctx.startDate));
      if (ctx.endDate) conditions.push(lte(campaignDailyStatsTable.date, ctx.endDate));

      const stats = await db.select().from(campaignDailyStatsTable).where(and(...conditions));
      const totalSpend = stats.reduce((s, r) => s + (r.spend || 0), 0);
      const totalClicks = stats.reduce((s, r) => s + (r.clicks || 0), 0);
      const totalImpressions = stats.reduce((s, r) => s + (r.impressions || 0), 0);

      const rows = campaigns.map(c => {
        const cStats = stats.filter(s => s.campaignId === c.id);
        const spend = cStats.reduce((s, r) => s + (r.spend || 0), 0);
        const clicks = cStats.reduce((s, r) => s + (r.clicks || 0), 0);
        return { campaign: c.name, spend: `$${spend.toFixed(2)}`, clicks, cpc: clicks > 0 ? `$${(spend / clicks).toFixed(2)}` : "N/A" };
      }).filter(r => parseFloat(r.spend.replace("$", "")) > 0).sort((a, b) => parseFloat(b.spend.replace("$", "")) - parseFloat(a.spend.replace("$", "")));

      return {
        answer: `**${platformLabel}** performance: $${totalSpend.toFixed(2)} spend, ${totalClicks} clicks, ${totalImpressions.toLocaleString()} impressions across ${campaigns.length} campaigns.`,
        data: rows,
        chartType: "table",
        chartLabel: `${platformLabel} Campaigns`,
      };
    },
  },
  {
    patterns: [
      /(?:show|list|what are|tell).*(campaign|campaigns)/i,
      /campaign.*(spend|performance|stats|cost)/i,
    ],
    description: "Campaign performance",
    handler: async (ctx) => {
      const campaigns = await db.select().from(campaignsTable).where(eq(campaignsTable.tenantId, ctx.tenantId));
      if (campaigns.length === 0) return { answer: "No campaigns found for your account.", chartType: "number" as const };

      const campaignIds = campaigns.map(c => c.id);
      const conditions: SQL[] = [inArray(campaignDailyStatsTable.campaignId, campaignIds)];
      if (ctx.startDate) conditions.push(gte(campaignDailyStatsTable.date, ctx.startDate));
      if (ctx.endDate) conditions.push(lte(campaignDailyStatsTable.date, ctx.endDate));

      const stats = await db.select().from(campaignDailyStatsTable).where(and(...conditions));

      const campaignMap = new Map<number, { name: string; platform: string; spend: number; clicks: number; impressions: number; conversions: number }>();
      for (const c of campaigns) {
        campaignMap.set(c.id, { name: c.name, platform: c.platform, spend: 0, clicks: 0, impressions: 0, conversions: 0 });
      }
      for (const s of stats) {
        const entry = campaignMap.get(s.campaignId);
        if (entry) {
          entry.spend += s.spend || 0;
          entry.clicks += s.clicks || 0;
          entry.impressions += s.impressions || 0;
          entry.conversions += s.conversions || 0;
        }
      }

      const rows = Array.from(campaignMap.values())
        .filter(c => c.spend > 0 || c.clicks > 0)
        .sort((a, b) => b.spend - a.spend)
        .map(c => ({
          campaign: c.name,
          platform: c.platform,
          spend: `$${c.spend.toFixed(2)}`,
          clicks: c.clicks,
          impressions: c.impressions,
          conversions: c.conversions,
          cpc: c.clicks > 0 ? `$${(c.spend / c.clicks).toFixed(2)}` : "N/A",
        }));

      const totalSpend = rows.reduce((s, r) => s + parseFloat(r.spend.replace("$", "")), 0);

      return {
        answer: `Here are your **${rows.length} active campaigns** with a total spend of **$${totalSpend.toFixed(2)}**:`,
        data: rows,
        chartType: "table",
        chartLabel: "Campaign Performance",
      };
    },
  },
  {
    patterns: [
      /(?:what(?:'s| is)|show|how much).*(total\s*)?spend/i,
      /(?:how much).*(spending|spent)/i,
      /ad\s*spend/i,
    ],
    description: "Total ad spend",
    handler: async (ctx) => {
      const spendData = await getSpendMetrics(ctx);
      return {
        answer: `Your total ad spend is **$${spendData.totalSpend.toFixed(2)}** with ${spendData.totalClicks} clicks and ${spendData.totalImpressions.toLocaleString()} impressions.`,
        data: [{ metric: "Total Spend", value: `$${spendData.totalSpend.toFixed(2)}`, clicks: spendData.totalClicks, impressions: spendData.totalImpressions }],
        chartType: "number",
      };
    },
  },
  {
    patterns: [
      /(?:what(?:'s| is)|show|how much).*(total\s*)?revenue/i,
      /(?:how much).*(made|earned|revenue)/i,
    ],
    description: "Total revenue",
    handler: async (ctx) => {
      const revData = await getRevenueMetrics(ctx);
      return {
        answer: `Your total revenue is **$${revData.totalRevenue.toFixed(2)}** from ${revData.jobCount} completed jobs. Average job value: **$${revData.avgRevenue.toFixed(2)}**.`,
        data: [{ metric: "Revenue", value: `$${revData.totalRevenue.toFixed(2)}`, jobs: revData.jobCount, avgValue: `$${revData.avgRevenue.toFixed(2)}` }],
        chartType: "number",
      };
    },
  },
  {
    patterns: [
      /(?:what(?:'s| is)|show).*(roas|return on ad spend)/i,
      /roas/i,
    ],
    description: "ROAS",
    handler: async (ctx) => {
      const [spendData, revData] = await Promise.all([getSpendMetrics(ctx), getRevenueMetrics(ctx)]);
      const roas = spendData.totalSpend > 0 ? revData.totalRevenue / spendData.totalSpend : 0;
      return {
        answer: `Your ROAS is **${roas.toFixed(1)}x** — $${revData.totalRevenue.toFixed(2)} revenue on $${spendData.totalSpend.toFixed(2)} ad spend.`,
        data: [{ metric: "ROAS", value: `${roas.toFixed(1)}x`, revenue: `$${revData.totalRevenue.toFixed(2)}`, spend: `$${spendData.totalSpend.toFixed(2)}` }],
        chartType: "number",
      };
    },
  },
  {
    patterns: [
      /(?:what(?:'s| is)|show).*(booking rate|book rate)/i,
      /booking rate/i,
    ],
    description: "Booking rate",
    handler: async (ctx) => {
      const leadData = await getLeadMetrics(ctx);
      const rate = leadData.total > 0 ? (leadData.booked / leadData.total) * 100 : 0;
      return {
        answer: `Your booking rate is **${rate.toFixed(1)}%** — ${leadData.booked} booked out of ${leadData.total} total leads.`,
        data: [{ metric: "Booking Rate", value: `${rate.toFixed(1)}%`, booked: leadData.booked, total: leadData.total }],
        chartType: "number",
      };
    },
  },
  {
    patterns: [
      /(?:what(?:'s| is)|show).*(close rate|closing rate)/i,
      /close rate/i,
    ],
    description: "Close rate",
    handler: async (ctx) => {
      const leadData = await getLeadMetrics(ctx);
      const rate = leadData.booked > 0 ? (leadData.sold / leadData.booked) * 100 : 0;
      return {
        answer: `Your close rate is **${rate.toFixed(1)}%** — ${leadData.sold} sold out of ${leadData.booked} booked appointments.`,
        data: [{ metric: "Close Rate", value: `${rate.toFixed(1)}%`, sold: leadData.sold, booked: leadData.booked }],
        chartType: "number",
      };
    },
  },
  {
    patterns: [
      /(?:how many|total|count).*(lead|leads)/i,
      /lead count/i,
      /(?:show|list).*(leads)/i,
    ],
    description: "Lead count and breakdown",
    handler: async (ctx) => {
      const leadData = await getLeadMetrics(ctx);
      const bySource = new Map<string, number>();
      for (const l of leadData.leads) {
        bySource.set(l.source, (bySource.get(l.source) || 0) + 1);
      }
      const sourceBreakdown = Array.from(bySource.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([source, count]) => ({ source, count, pct: `${(count / leadData.total * 100).toFixed(1)}%` }));

      return {
        answer: `You have **${leadData.total} total leads** — ${leadData.booked} booked, ${leadData.sold} sold.\n\nBreakdown by source:`,
        data: sourceBreakdown,
        chartType: "bar",
        chartLabel: "Leads by Source",
      };
    },
  },
  {
    patterns: [
      /(?:what(?:'s| is)|show).*(attribution|match rate)/i,
      /attribution/i,
    ],
    description: "Attribution match rate",
    handler: async (ctx) => {
      const jobConditions: SQL[] = [eq(jobsTable.tenantId, ctx.tenantId)];
      if (ctx.startDate) jobConditions.push(gte(jobsTable.createdAt, new Date(ctx.startDate)));
      if (ctx.endDate) jobConditions.push(lte(jobsTable.createdAt, new Date(ctx.endDate)));

      const jobs = await db.select().from(jobsTable).where(and(...jobConditions));
      const matched = jobs.filter(j => j.matchLevel && j.matchLevel !== "unmatched");
      const rate = jobs.length > 0 ? (matched.length / jobs.length * 100) : 0;

      const byLevel = new Map<string, number>();
      for (const j of matched) {
        const lvl = j.matchLevel || "unknown";
        byLevel.set(lvl, (byLevel.get(lvl) || 0) + 1);
      }

      const breakdown = Array.from(byLevel.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([level, count]) => ({ level, count, pct: `${(count / jobs.length * 100).toFixed(1)}%` }));

      return {
        answer: `Attribution match rate: **${rate.toFixed(1)}%** (${matched.length} of ${jobs.length} jobs matched).\n\nBreakdown by match level:`,
        data: breakdown,
        chartType: "bar",
        chartLabel: "Attribution by Level",
      };
    },
  },
  {
    patterns: [
      /(?:what(?:'s| is)|show|give).*(overview|summary|dashboard|snapshot|kpis)/i,
      /how.*(doing|performing|going)/i,
    ],
    description: "Overview summary",
    handler: async (ctx) => {
      const [leadData, spendData, revData] = await Promise.all([
        getLeadMetrics(ctx),
        getSpendMetrics(ctx),
        getRevenueMetrics(ctx),
      ]);

      const cpl = leadData.total > 0 ? spendData.totalSpend / leadData.total : 0;
      const roas = spendData.totalSpend > 0 ? revData.totalRevenue / spendData.totalSpend : 0;
      const bookingRate = leadData.total > 0 ? (leadData.booked / leadData.total * 100) : 0;
      const closeRate = leadData.booked > 0 ? (leadData.sold / leadData.booked * 100) : 0;

      return {
        answer: `Here's your marketing overview:\n\n• **Leads:** ${leadData.total} total, ${leadData.booked} booked, ${leadData.sold} sold\n• **Ad Spend:** $${spendData.totalSpend.toFixed(2)}\n• **Revenue:** $${revData.totalRevenue.toFixed(2)} from ${revData.jobCount} jobs\n• **CPL:** $${cpl.toFixed(2)}\n• **ROAS:** ${roas.toFixed(1)}x\n• **Booking Rate:** ${bookingRate.toFixed(1)}%\n• **Close Rate:** ${closeRate.toFixed(1)}%`,
        data: [
          { metric: "Total Leads", value: leadData.total },
          { metric: "Ad Spend", value: `$${spendData.totalSpend.toFixed(2)}` },
          { metric: "Revenue", value: `$${revData.totalRevenue.toFixed(2)}` },
          { metric: "CPL", value: `$${cpl.toFixed(2)}` },
          { metric: "ROAS", value: `${roas.toFixed(1)}x` },
          { metric: "Booking Rate", value: `${bookingRate.toFixed(1)}%` },
          { metric: "Close Rate", value: `${closeRate.toFixed(1)}%` },
        ],
        chartType: "table",
      };
    },
  },
  {
    patterns: [
      /(?:which|what|best|top|worst).*(source|channel).*(best|most|highest|lowest|worst|perform)/i,
      /(?:best|top|worst).*(source|channel)/i,
      /(?:which|what).*(source|channel)/i,
    ],
    description: "Best performing source",
    handler: async (ctx) => {
      const leadData = await getLeadMetrics(ctx);
      const bySource = new Map<string, { total: number; booked: number; sold: number }>();
      for (const l of leadData.leads) {
        const entry = bySource.get(l.source) || { total: 0, booked: 0, sold: 0 };
        entry.total++;
        if (l.status === "booked" || l.status === "sold") entry.booked++;
        if (l.status === "sold") entry.sold++;
        bySource.set(l.source, entry);
      }

      const rows = Array.from(bySource.entries())
        .map(([source, s]) => ({
          source,
          leads: s.total,
          booked: s.booked,
          sold: s.sold,
          bookingRate: `${s.total > 0 ? (s.booked / s.total * 100).toFixed(1) : 0}%`,
          closeRate: `${s.booked > 0 ? (s.sold / s.booked * 100).toFixed(1) : 0}%`,
        }))
        .sort((a, b) => b.leads - a.leads);

      const best = rows[0];
      return {
        answer: best
          ? `Your top lead source is **${best.source}** with ${best.leads} leads (${best.bookingRate} booking rate).`
          : "No lead data available to analyze sources.",
        data: rows,
        chartType: "table",
        chartLabel: "Performance by Source",
      };
    },
  },
  {
    patterns: [
      /(?:script|change|update|changelog|change.?log|what.?changed|recent.?changes)/i,
    ],
    description: "Script changes and changelog",
    handler: async (ctx) => {
      const dateRange = { startDate: ctx.startDate, endDate: ctx.endDate };
      const conds: SQL[] = [eq(changeLogsTable.tenantId, ctx.tenantId)];
      if (dateRange.startDate) conds.push(gte(changeLogsTable.date, dateRange.startDate));
      if (dateRange.endDate) conds.push(lte(changeLogsTable.date, dateRange.endDate));

      const logs = await db.select().from(changeLogsTable)
        .where(and(...conds))
        .orderBy(desc(changeLogsTable.date))
        .limit(20);

      if (logs.length === 0) {
        return { answer: "No changelog entries found for this period.", chartType: "number" as const };
      }

      const scriptLogs = logs.filter(l => l.category === "scripts");
      const otherLogs = logs.filter(l => l.category !== "scripts");

      let answer = `Found **${logs.length}** changelog entries:\n\n`;
      if (scriptLogs.length > 0) {
        answer += `**Script Changes (${scriptLogs.length}):**\n`;
        for (const l of scriptLogs.slice(0, 5)) {
          answer += `• ${l.date}: ${l.title} — ${l.description}\n`;
        }
        answer += "\n";
      }
      if (otherLogs.length > 0) {
        answer += `**Other Changes (${otherLogs.length}):**\n`;
        for (const l of otherLogs.slice(0, 5)) {
          answer += `• ${l.date}: ${l.title} (${l.category})\n`;
        }
      }

      if (scriptLogs.length > 0) {
        answer += "\nScript changes are overlaid on your spend vs. revenue chart so you can correlate script updates with performance shifts.";
      }

      return {
        answer,
        data: logs.map(l => ({ date: l.date, title: l.title, category: l.category, description: l.description })),
        chartType: "table" as const,
        chartLabel: "Changelog Entries",
      };
    },
  },
];

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

function sanitizeHistory(history: ConversationTurn[]): ConversationTurn[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter(t => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
    .map(t => ({ role: t.role, content: t.content.slice(0, 500) }))
    .slice(-10);
}

function findLastSubstantiveUserQuestion(history: ConversationTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    if (t.role !== "user") continue;
    const c = t.content.toLowerCase().trim();
    if (c.length > 10 && !/^(why\??|tell me more|more details|explain|and |what about |how about |for |in |during )/.test(c)) {
      return t.content;
    }
  }
  return history.find(t => t.role === "user")?.content || null;
}

function resolveQuestionWithContext(question: string, history: ConversationTurn[]): string {
  const q = question.toLowerCase().trim();
  const safeHistory = sanitizeHistory(history);

  if (q === "why" || q === "why?" || q === "tell me more" || q === "more details" || q === "explain") {
    const lastSubstantive = findLastSubstantiveUserQuestion(safeHistory);
    if (lastSubstantive) return `Why is ${lastSubstantive}`;
  }

  if (/^(and|what about|how about)\s+(.+)/i.test(q)) {
    const match = q.match(/^(?:and|what about|how about)\s+(.+)/i);
    if (match) {
      const lastAssistant = [...safeHistory].reverse().find(t => t.role === "assistant");
      if (lastAssistant) {
        const lc = lastAssistant.content.toLowerCase();
        if (lc.includes("cpl") || lc.includes("cost per lead")) {
          return `Show ${match[1]} cost per lead`;
        }
        if (lc.includes("campaign")) {
          return `Show ${match[1]} campaigns`;
        }
        if (lc.includes("lead")) {
          return `Show ${match[1]} leads`;
        }
        if (lc.includes("spend")) {
          return `Show ${match[1]} spend`;
        }
      }
    }
  }

  if (/^(for|in|during)\s+(last\s+\w+|this\s+\w+)/i.test(q)) {
    const lastSubstantive = findLastSubstantiveUserQuestion(safeHistory);
    if (lastSubstantive) return `${lastSubstantive} ${question}`;
  }

  return question;
}

export async function processQuestion(question: string, tenantId: number, conversationHistory: ConversationTurn[] = []): Promise<QueryResult> {
  const resolvedQuestion = resolveQuestionWithContext(question, conversationHistory);
  const dateRange = extractDateRange(resolvedQuestion);
  const ctx: ChatContext = { tenantId, ...dateRange };

  for (const pattern of queryPatterns) {
    for (const regex of pattern.patterns) {
      const match = resolvedQuestion.match(regex);
      if (match) {
        try {
          return await pattern.handler(ctx, match, resolvedQuestion);
        } catch (err) {
          console.error(`[Chat Analytics] Error processing pattern "${pattern.description}":`, err);
          return {
            answer: "I encountered an error processing your question. Please try rephrasing it.",
            chartType: "number",
          };
        }
      }
    }
  }

  return {
    answer: `I'm not sure how to answer that specific question. Here are some things you can ask me about:\n\n• **Spend & Costs:** "What's my total spend?" or "What's my CPL?"\n• **Revenue:** "Show me total revenue" or "What's my ROAS?"\n• **Leads:** "How many leads do I have?" or "Show leads by source"\n• **Campaigns:** "Show all campaigns" or "Google Ads performance"\n• **Rates:** "What's my booking rate?" or "Show close rate"\n• **Overview:** "How am I doing?" or "Give me a summary"\n• **Analysis:** "Why did my CPL go up?"`,
    chartType: "number",
  };
}

export type { ConversationTurn };

export async function generateSuggestions(tenantId: number): Promise<string[]> {
  const range = last30Days();
  const ctx: ChatContext = { tenantId, ...range };

  const suggestions: string[] = [];

  try {
    const [leadData, spendData, revData] = await Promise.all([
      getLeadMetrics(ctx),
      getSpendMetrics(ctx),
      getRevenueMetrics(ctx),
    ]);

    const prevEnd = new Date(new Date(range.startDate).getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - 30 * 86400000);
    const prevCtx = { tenantId, startDate: prevStart.toISOString().split("T")[0], endDate: prevEnd.toISOString().split("T")[0] };
    const prevLeads = await getLeadMetrics(prevCtx);
    const prevSpend = await getSpendMetrics(prevCtx);

    const currCPL = leadData.total > 0 ? spendData.totalSpend / leadData.total : 0;
    const prevCPL = prevLeads.total > 0 ? prevSpend.totalSpend / prevLeads.total : 0;

    if (prevCPL > 0 && currCPL > prevCPL * 1.1) {
      const pctUp = ((currCPL - prevCPL) / prevCPL * 100).toFixed(0);
      suggestions.push(`Your CPL increased ${pctUp}% this period — want to know why?`);
    }

    if (prevCPL > 0 && currCPL < prevCPL * 0.9) {
      const pctDown = ((prevCPL - currCPL) / prevCPL * 100).toFixed(0);
      suggestions.push(`Great news! CPL dropped ${pctDown}% — see what's working`);
    }

    const bookingRate = leadData.total > 0 ? (leadData.booked / leadData.total * 100) : 0;
    if (bookingRate < 40) {
      suggestions.push("Your booking rate is below 40% — what can we improve?");
    }

    const roas = spendData.totalSpend > 0 ? revData.totalRevenue / spendData.totalSpend : 0;
    if (roas > 5) {
      suggestions.push(`ROAS is ${roas.toFixed(1)}x — show me which campaigns are driving results`);
    }

    if (leadData.total > 0) {
      suggestions.push("Show me leads broken down by source");
    }

    suggestions.push("How am I performing this month?");
    suggestions.push("Show all campaign performance");

  } catch (err) {
    console.error("[Chat Analytics] Error generating suggestions:", err);
    suggestions.push("How am I performing this month?");
    suggestions.push("What's my cost per lead?");
    suggestions.push("Show all campaigns and total spend");
  }

  return suggestions.slice(0, 5);
}
