import type { Column } from "drizzle-orm";
import {
  db,
  leadsTable,
  jobsTable,
  campaignsTable,
  campaignDailyStatsTable,
  attributionEventsTable,
  changeLogsTable,
  reviewsTable,
  reviewDailyStatsTable,
  coordinatorDailyStatsTable,
  automationRulesTable,
  automationAlertsTable,
  integrationSyncLogsTable,
  callAttemptsTable,
  scheduledFollowupsTable,
  usersTable,
  funnelTypesTable,
  tenantFunnelTypesTable,
} from "@workspace/db";
import { eq, and, gte, lte, sql, inArray, SQL, desc, asc, count, sum, avg } from "drizzle-orm";

export const SCHEMA_DESCRIPTION = `
You have access to the following database tables for this tenant's marketing data:

1. **leads** - Potential customers / inbound leads
   Columns: id, tenantId, firstName, lastName, phone, email, source (text - e.g. "google", "meta", "organic", "referral"), leadType (text - maps to funnel type name, e.g. "Fit Funnel", "Emergency Repair"), interestType (text), status (enum: "new","contacted","booked","sold","lost","cancelled"), isNewCustomer (boolean), matchedGclid, assignedTo (text - coordinator name), disposition (text), createdAt, updatedAt
   NOTE: leadType stores the funnel type name. To analyze data by funnel type, group leads by leadType.

2. **campaigns** - Marketing campaigns with aggregated spend data (Google Ads, Meta, etc.)
   Columns: id, tenantId, platform (text - "google","meta","facebook"), externalId, name, status, createdAt
   Auto-joined financial data: spend, clicks, impressions, conversions (aggregated from campaign_daily_stats)
   Use this table for per-campaign spend/performance breakdowns.

3. **campaign_daily_stats** - Daily performance metrics per campaign
   Columns: id, campaignId (FK to campaigns), date (date string), spend (float), impressions (int), clicks (int), conversions (int)
   NOTE: This table does NOT have tenantId directly. To filter by tenant, first get campaignIds from campaigns table.

4. **jobs** - Service jobs / completed work with revenue
   Columns: id, tenantId, jobType, revenue (float), status (enum: "pending","in_progress","completed","cancelled"), matchedGclid, matchLevel (text - "diamond","golden","silver","bronze","unmatched"), completedAt, createdAt, updatedAt
   NOTE: customerName, serviceAddress, stJobId and other ST PII fields are purged (set to NULL) after 24 hours for data retention compliance. Do not rely on these fields for historical queries.

5. **attribution_events** - Click/call/form tracking events
   Columns: id, tenantId, eventType (enum: "click","call","form_fill"), gclid, wbraid, fbclid, utmSource, utmCampaign, utmMedium, landingPage, matchLevel, matchConfidence, createdAt

6. **reviews** - Customer reviews from platforms like Podium
   Columns: id, tenantId, platform, externalId, reviewerName, rating (float 1-5), body (text), sentiment (text - "positive","negative","neutral"), reviewDate, createdAt

7. **review_daily_stats** - Daily aggregated review metrics
   Columns: id, tenantId, date, totalReviews, averageRating, positiveCount, negativeCount, neutralCount, createdAt

8. **coordinator_daily_stats** - Daily performance metrics per sales coordinator
   Columns: id, userId (FK to users), tenantId, date, callsMade, bookingsCount, bookingRate (float 0-1), commission (float), avgSpeedToLead (float in seconds), soldCount, newLeadsHandled, createdAt

9. **automation_rules** - Tenant-defined monitoring rules
   Columns: id, name, description, conditionType (enum: "spend_below","spend_above","days_active_above","conversions_below","cpl_above","roas_below"), conditionValue, actionType, lookbackDays, platform, tenantId, isEnabled, createdBy, createdAt

10. **automation_alerts** - Triggered alerts from automation rules
    Columns: id, ruleId, tenantId, campaignId, campaignName, tenantName, conditionType, conditionValue, actualValue, actionType, actionTaken, isAcknowledged, acknowledgedBy, acknowledgedAt, createdAt

11. **change_logs** - Audit trail of administrative changes
    Columns: id, tenantId, date, title, description, category (text - e.g. "scripts","general","campaigns"), createdAt

12. **call_attempts** - Individual call/contact attempts on leads
    Columns: id, leadId (FK to leads), userId (FK to users), method (text), outcome (text), platform, attemptedAt, notes

13. **scheduled_followups** - Future follow-up tasks for leads
    Columns: id, leadId (FK to leads), userId (FK to users), reason, scheduledFor, completed (boolean), completedAt, createdAt

14. **integration_sync_logs** - Sync history with external tools
    Columns: id, tenantId, integration, syncType, status, recordsProcessed, errorMessage, startedAt, completedAt, createdAt

15. **users** - User accounts (coordinators, admins)
    Columns: id, tenantId, email, name, role (enum: "super_admin","agency_user","client_admin","client_user"), createdAt

16. **funnel_types** - Global funnel type definitions (e.g. "Fit Funnel", "Emergency Repair", "Financing Quiz")
    Columns: id, name, slug, description, isActive (boolean), createdAt, updatedAt
    NOTE: This is a global table (no tenantId). Use tenant_funnel_types to see which funnels a tenant uses.

17. **tenant_funnel_types** - Association between tenants and their active funnel types
    Columns: tenantId, funnelTypeId (FK to funnel_types), createdAt
    Join with funnel_types to get funnel names for a specific tenant.

IMPORTANT CROSS-TABLE RELATIONSHIPS:
- "Funnel types" = leads.leadType values. To show data "by funnel type" or "across funnel types", query leads and group by leadType.
- To get spend by funnel type, you need BOTH tables: query leads (grouped by leadType for lead counts) AND campaigns (for total spend). The AI answer should correlate these.
- campaign_daily_stats links to campaigns via campaignId; campaigns link to tenants via tenantId.

Common computed metrics:
- CPL (Cost Per Lead) = total spend / total leads
- ROAS (Return on Ad Spend) = total revenue / total spend
- Booking Rate = booked leads / total leads
- Close Rate = sold leads / booked leads
- CPC (Cost Per Click) = total spend / total clicks
- CTR (Click Through Rate) = total clicks / total impressions
`;

export interface QueryPlan {
  tables: string[];
  filters?: Record<string, unknown>;
  aggregations?: string[];
  groupBy?: string[];
  orderBy?: { column: string; direction: "asc" | "desc" }[];
  limit?: number;
  dateRange?: { start: string; end: string };
  computedMetrics?: string[];
}

interface QueryExecutionResult {
  data: Record<string, unknown>[];
  summary: string;
}

async function getCampaignIdsForTenant(tenantId: number): Promise<number[]> {
  const campaigns = await db
    .select({ id: campaignsTable.id })
    .from(campaignsTable)
    .where(eq(campaignsTable.tenantId, tenantId));
  return campaigns.map((c) => c.id);
}

async function getUserIdsForTenant(tenantId: number): Promise<number[]> {
  const users = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.tenantId, tenantId));
  return users.map((u) => u.id);
}

async function getLeadIdsForTenant(tenantId: number): Promise<number[]> {
  const leads = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(eq(leadsTable.tenantId, tenantId));
  return leads.map((l) => l.id);
}

export async function executeQueryPlan(
  tenantId: number,
  plan: QueryPlan
): Promise<QueryExecutionResult> {
  const MAX_ROWS = 5000;
  const results: Record<string, unknown>[] = [];
  const summaryParts: string[] = [];
  const groupByFields = plan.groupBy && plan.groupBy.length > 0 ? plan.groupBy : null;
  const aggregations = plan.aggregations && plan.aggregations.length > 0 ? plan.aggregations : ["count"];

  for (const table of plan.tables) {
    let tableData = await queryTable(tenantId, table, plan);

    if (tableData.length > MAX_ROWS) {
      tableData = tableData.slice(0, MAX_ROWS);
    }

    if (groupByFields && plan.tables.length > 1) {
      const sampleRow = tableData[0];
      if (sampleRow) {
        const hasGroupFields = groupByFields.some(col => col in sampleRow);
        if (hasGroupFields) {
          tableData = applyGroupByAggregation(tableData, groupByFields, aggregations);
          summaryParts.push(`${table}: ${tableData.length} groups (by ${groupByFields.join(", ")})`);
        } else {
          summaryParts.push(`${table}: ${tableData.length} rows (no groupBy match)`);
        }
      } else {
        summaryParts.push(`${table}: 0 rows`);
      }
    } else {
      summaryParts.push(`${table}: ${tableData.length} rows`);
    }

    for (const row of tableData) {
      (row as Record<string, unknown>).__sourceTable = table;
    }
    results.push(...tableData);
  }

  if (plan.computedMetrics && plan.computedMetrics.length > 0) {
    const metrics = await computeMetrics(tenantId, plan);
    if (metrics.length > 0) {
      results.push(...metrics);
      summaryParts.push(`computed ${plan.computedMetrics.join(", ")}`);
    }
  }

  let processed = results;

  if (groupByFields && plan.tables.length === 1) {
    processed = applyGroupByAggregation(processed, groupByFields, aggregations);
    summaryParts.push(`grouped by ${groupByFields.join(", ")} with ${aggregations.join(", ")}`);
  }

  if (plan.orderBy && plan.orderBy.length > 0) {
    processed = applyOrderBy(processed, plan.orderBy);
  }

  const limitedResults = plan.limit
    ? processed.slice(0, Math.min(plan.limit, 500))
    : processed.slice(0, 100);

  for (const row of limitedResults) {
    delete (row as Record<string, unknown>).__sourceTable;
  }

  return {
    data: limitedResults,
    summary: `Queried ${plan.tables.join(", ")} for tenant ${tenantId}. ${summaryParts.join("; ")}. Returned ${limitedResults.length} rows.`,
  };
}

function applyOrderBy(
  rows: Record<string, unknown>[],
  orderBy: { column: string; direction: "asc" | "desc" }[]
): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    for (const { column, direction } of orderBy) {
      const aVal = a[column];
      const bVal = b[column];
      if (aVal === bVal) continue;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const cmp = typeof aVal === "number" && typeof bVal === "number"
        ? aVal - bVal
        : String(aVal).localeCompare(String(bVal));
      return direction === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

function applyGroupByAggregation(
  rows: Record<string, unknown>[],
  groupBy: string[],
  aggregations: string[]
): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = groupBy.map(col => String(row[col] ?? "")).join("||");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const explicitAggCols = new Set<string>();
  for (const agg of aggregations) {
    const match = agg.match(/^(count|sum|avg|min|max)\((.+)\)$/i);
    if (match) explicitAggCols.add(match[2]);
  }

  const groupBySet = new Set(groupBy);

  const result: Record<string, unknown>[] = [];
  for (const [, groupRows] of groups) {
    const aggregated: Record<string, unknown> = {};
    for (const col of groupBy) {
      aggregated[col] = groupRows[0][col];
    }
    for (const agg of aggregations) {
      const match = agg.match(/^(count|sum|avg|min|max)\((.+)\)$/i);
      if (match) {
        const [, fn, col] = match;
        const values = groupRows.map(r => Number(r[col])).filter(n => !isNaN(n));
        switch (fn.toLowerCase()) {
          case "count":
            aggregated[`${fn}(${col})`] = groupRows.length;
            break;
          case "sum":
            aggregated[`${fn}(${col})`] = values.reduce((s, v) => s + v, 0);
            break;
          case "avg":
            aggregated[`${fn}(${col})`] = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
            break;
          case "min":
            aggregated[`${fn}(${col})`] = values.length > 0 ? Math.min(...values) : 0;
            break;
          case "max":
            aggregated[`${fn}(${col})`] = values.length > 0 ? Math.max(...values) : 0;
            break;
        }
      } else if (agg.toLowerCase() === "count") {
        aggregated["count"] = groupRows.length;
      }
    }

    const SKIP_SUM_FIELDS = new Set(["id", "tenantId", "campaignId", "userId", "leadId", "ruleId", "funnelTypeId"]);
    const firstRow = groupRows[0];
    for (const [key, val] of Object.entries(firstRow)) {
      if (groupBySet.has(key) || explicitAggCols.has(key)) continue;
      if (key in aggregated) continue;
      if (SKIP_SUM_FIELDS.has(key)) {
        aggregated[key] = val;
        continue;
      }
      const numVal = Number(val);
      if (val !== null && val !== undefined && val !== "" && typeof val !== "boolean" && !isNaN(numVal)) {
        aggregated[key] = groupRows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
      } else {
        aggregated[key] = val;
      }
    }

    result.push(aggregated);
  }
  return result;
}

async function queryTable(
  tenantId: number,
  table: string,
  plan: QueryPlan
): Promise<Record<string, unknown>[]> {
  const limit = Math.min(plan.limit || 50, 100);

  switch (table) {
    case "leads":
      return queryLeads(tenantId, plan, limit);
    case "campaigns":
      return queryCampaigns(tenantId, plan, limit);
    case "campaign_daily_stats":
      return queryCampaignDailyStats(tenantId, plan, limit);
    case "jobs":
      return queryJobs(tenantId, plan, limit);
    case "attribution_events":
      return queryAttributionEvents(tenantId, plan, limit);
    case "reviews":
      return queryReviews(tenantId, plan, limit);
    case "review_daily_stats":
      return queryReviewDailyStats(tenantId, plan, limit);
    case "coordinator_daily_stats":
      return queryCoordinatorDailyStats(tenantId, plan, limit);
    case "automation_rules":
      return queryAutomationRules(tenantId, plan, limit);
    case "automation_alerts":
      return queryAutomationAlerts(tenantId, plan, limit);
    case "change_logs":
      return queryChangeLogs(tenantId, plan, limit);
    case "call_attempts":
      return queryCallAttempts(tenantId, plan, limit);
    case "scheduled_followups":
      return queryScheduledFollowups(tenantId, plan, limit);
    case "integration_sync_logs":
      return queryIntegrationSyncLogs(tenantId, plan, limit);
    case "users":
      return queryUsers(tenantId, plan, limit);
    case "funnel_types":
      return queryFunnelTypes(tenantId, plan, limit);
    case "tenant_funnel_types":
      return queryTenantFunnelTypes(tenantId, plan, limit);
    default:
      return [];
  }
}

function buildDateConditions(
  dateColumn: Column,
  plan: QueryPlan,
  isDateString: boolean = false
): SQL[] {
  const conditions: SQL[] = [];
  const range = plan.dateRange || (plan.filters?.dateRange as { start?: string; end?: string } | undefined);
  if (range) {
    if (range.start) {
      conditions.push(
        gte(dateColumn, isDateString ? range.start : new Date(range.start))
      );
    }
    if (range.end) {
      conditions.push(
        lte(dateColumn, isDateString ? range.end : new Date(range.end))
      );
    }
  }
  return conditions;
}

async function queryLeads(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [eq(leadsTable.tenantId, tenantId)];
  conditions.push(...buildDateConditions(leadsTable.createdAt, plan));
  const f = plan.filters || {};
  if (f.source) conditions.push(eq(leadsTable.source, String(f.source)));
  if (f.status) conditions.push(eq(leadsTable.status, String(f.status) as typeof leadsTable.status.enumValues[number]));
  if (f.leadType) conditions.push(eq(leadsTable.leadType, String(f.leadType)));
  if (f.assignedTo) conditions.push(eq(leadsTable.assignedTo, String(f.assignedTo)));
  if (f.disposition) conditions.push(eq(leadsTable.disposition, String(f.disposition)));

  const rows = await db
    .select()
    .from(leadsTable)
    .where(and(...conditions))
    .orderBy(desc(leadsTable.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    name: `${r.firstName} ${r.lastName}`,
    source: r.source,
    leadType: r.leadType,
    status: r.status,
    assignedTo: r.assignedTo,
    disposition: r.disposition,
    isNewCustomer: r.isNewCustomer,
    createdAt: r.createdAt?.toISOString?.() || r.createdAt,
  }));
}

async function queryCampaigns(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [eq(campaignsTable.tenantId, tenantId)];
  const f = plan.filters || {};
  if (f.platform) conditions.push(eq(campaignsTable.platform, String(f.platform)));
  if (f.status) conditions.push(eq(campaignsTable.status, String(f.status)));

  const dateConditions: SQL[] = [];
  const range = plan.dateRange || (plan.filters?.dateRange as { start?: string; end?: string } | undefined);
  if (range?.start) dateConditions.push(gte(campaignDailyStatsTable.date, range.start));
  if (range?.end) dateConditions.push(lte(campaignDailyStatsTable.date, range.end));

  const rows = await db
    .select({
      id: campaignsTable.id,
      name: campaignsTable.name,
      platform: campaignsTable.platform,
      status: campaignsTable.status,
      createdAt: campaignsTable.createdAt,
      totalSpend: sum(campaignDailyStatsTable.spend),
      totalClicks: sum(campaignDailyStatsTable.clicks),
      totalImpressions: sum(campaignDailyStatsTable.impressions),
      totalConversions: sum(campaignDailyStatsTable.conversions),
    })
    .from(campaignsTable)
    .leftJoin(
      campaignDailyStatsTable,
      and(
        eq(campaignDailyStatsTable.campaignId, campaignsTable.id),
        ...dateConditions
      )
    )
    .where(and(...conditions))
    .groupBy(campaignsTable.id, campaignsTable.name, campaignsTable.platform, campaignsTable.status, campaignsTable.createdAt)
    .orderBy(desc(sql`sum(${campaignDailyStatsTable.spend})`))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    status: r.status,
    spend: Number(r.totalSpend) || 0,
    clicks: Number(r.totalClicks) || 0,
    impressions: Number(r.totalImpressions) || 0,
    conversions: Number(r.totalConversions) || 0,
    createdAt: r.createdAt?.toISOString?.() || r.createdAt,
  }));
}

async function queryCampaignDailyStats(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const campaignIds = await getCampaignIdsForTenant(tenantId);
  if (campaignIds.length === 0) return [];

  const conditions: SQL[] = [
    inArray(campaignDailyStatsTable.campaignId, campaignIds),
  ];
  conditions.push(
    ...buildDateConditions(campaignDailyStatsTable.date, plan, true)
  );

  const f = plan.filters || {};
  if (f.campaignId)
    conditions.push(
      eq(campaignDailyStatsTable.campaignId, Number(f.campaignId))
    );

  if (
    plan.aggregations?.includes("sum") ||
    plan.groupBy?.includes("date") ||
    plan.groupBy?.includes("campaignId")
  ) {
    const groupCol = plan.groupBy?.includes("date")
      ? campaignDailyStatsTable.date
      : campaignDailyStatsTable.campaignId;

    const rows = await db
      .select({
        groupKey: groupCol,
        totalSpend: sum(campaignDailyStatsTable.spend),
        totalClicks: sum(campaignDailyStatsTable.clicks),
        totalImpressions: sum(campaignDailyStatsTable.impressions),
        totalConversions: sum(campaignDailyStatsTable.conversions),
      })
      .from(campaignDailyStatsTable)
      .where(and(...conditions))
      .groupBy(groupCol)
      .orderBy(plan.groupBy?.includes("date") ? asc(groupCol) : desc(sql`sum(${campaignDailyStatsTable.spend})`))
      .limit(limit);

    return rows.map((r) => ({
      [plan.groupBy?.includes("date") ? "date" : "campaignId"]: r.groupKey,
      spend: Number(r.totalSpend) || 0,
      clicks: Number(r.totalClicks) || 0,
      impressions: Number(r.totalImpressions) || 0,
      conversions: Number(r.totalConversions) || 0,
    }));
  }

  const rows = await db
    .select()
    .from(campaignDailyStatsTable)
    .where(and(...conditions))
    .orderBy(desc(campaignDailyStatsTable.date))
    .limit(limit);

  return rows.map((r) => ({
    campaignId: r.campaignId,
    date: r.date,
    spend: r.spend,
    clicks: r.clicks,
    impressions: r.impressions,
    conversions: r.conversions,
  }));
}

async function queryJobs(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [eq(jobsTable.tenantId, tenantId)];
  conditions.push(...buildDateConditions(jobsTable.createdAt, plan));
  const f = plan.filters || {};
  if (f.status) conditions.push(eq(jobsTable.status, String(f.status) as typeof jobsTable.status.enumValues[number]));
  if (f.jobType) conditions.push(eq(jobsTable.jobType, String(f.jobType)));
  if (f.matchLevel) conditions.push(eq(jobsTable.matchLevel, String(f.matchLevel)));

  const rows = await db
    .select()
    .from(jobsTable)
    .where(and(...conditions))
    .orderBy(desc(jobsTable.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    customerName: r.customerName ?? "[Purged]",
    jobType: r.jobType,
    revenue: r.revenue,
    status: r.status,
    matchLevel: r.matchLevel,
    completedAt: r.completedAt?.toISOString?.() || r.completedAt,
    createdAt: r.createdAt?.toISOString?.() || r.createdAt,
  }));
}

async function queryAttributionEvents(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [eq(attributionEventsTable.tenantId, tenantId)];
  conditions.push(
    ...buildDateConditions(attributionEventsTable.createdAt, plan)
  );
  const f = plan.filters || {};
  if (f.eventType) conditions.push(eq(attributionEventsTable.eventType, String(f.eventType) as typeof attributionEventsTable.eventType.enumValues[number]));

  const rows = await db
    .select()
    .from(attributionEventsTable)
    .where(and(...conditions))
    .orderBy(desc(attributionEventsTable.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    utmSource: r.utmSource,
    utmCampaign: r.utmCampaign,
    utmMedium: r.utmMedium,
    landingPage: r.landingPage,
    matchLevel: r.matchLevel,
    matchConfidence: r.matchConfidence,
    createdAt: r.createdAt?.toISOString?.() || r.createdAt,
  }));
}

async function queryReviews(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [eq(reviewsTable.tenantId, tenantId)];
  conditions.push(
    ...buildDateConditions(reviewsTable.reviewDate, plan, true)
  );
  const f = plan.filters || {};
  if (f.sentiment) conditions.push(eq(reviewsTable.sentiment, String(f.sentiment)));
  if (f.platform) conditions.push(eq(reviewsTable.platform, String(f.platform)));

  const rows = await db
    .select()
    .from(reviewsTable)
    .where(and(...conditions))
    .orderBy(desc(reviewsTable.reviewDate))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    reviewerName: r.reviewerName,
    rating: r.rating,
    body: r.body,
    sentiment: r.sentiment,
    platform: r.platform,
    reviewDate: r.reviewDate,
  }));
}

async function queryReviewDailyStats(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [eq(reviewDailyStatsTable.tenantId, tenantId)];
  conditions.push(
    ...buildDateConditions(reviewDailyStatsTable.date, plan, true)
  );

  const rows = await db
    .select()
    .from(reviewDailyStatsTable)
    .where(and(...conditions))
    .orderBy(desc(reviewDailyStatsTable.date))
    .limit(limit);

  return rows.map((r) => ({
    date: r.date,
    totalReviews: r.totalReviews,
    averageRating: r.averageRating,
    positiveCount: r.positiveCount,
    negativeCount: r.negativeCount,
    neutralCount: r.neutralCount,
  }));
}

async function queryCoordinatorDailyStats(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [
    eq(coordinatorDailyStatsTable.tenantId, tenantId),
  ];
  conditions.push(
    ...buildDateConditions(coordinatorDailyStatsTable.date, plan, true)
  );

  const rows = await db
    .select({
      id: coordinatorDailyStatsTable.id,
      userId: coordinatorDailyStatsTable.userId,
      date: coordinatorDailyStatsTable.date,
      callsMade: coordinatorDailyStatsTable.callsMade,
      bookingsCount: coordinatorDailyStatsTable.bookingsCount,
      bookingRate: coordinatorDailyStatsTable.bookingRate,
      commission: coordinatorDailyStatsTable.commission,
      avgSpeedToLead: coordinatorDailyStatsTable.avgSpeedToLead,
      soldCount: coordinatorDailyStatsTable.soldCount,
      newLeadsHandled: coordinatorDailyStatsTable.newLeadsHandled,
      userName: usersTable.name,
    })
    .from(coordinatorDailyStatsTable)
    .leftJoin(usersTable, eq(coordinatorDailyStatsTable.userId, usersTable.id))
    .where(and(...conditions))
    .orderBy(desc(coordinatorDailyStatsTable.date))
    .limit(limit);

  return rows.map((r) => ({
    coordinator: r.userName || `User #${r.userId}`,
    date: r.date,
    callsMade: r.callsMade,
    bookingsCount: r.bookingsCount,
    bookingRate: r.bookingRate,
    commission: r.commission,
    avgSpeedToLead: r.avgSpeedToLead,
    soldCount: r.soldCount,
    newLeadsHandled: r.newLeadsHandled,
  }));
}

async function queryAutomationRules(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [eq(automationRulesTable.tenantId, tenantId)];

  const rows = await db
    .select()
    .from(automationRulesTable)
    .where(and(...conditions))
    .orderBy(desc(automationRulesTable.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    conditionType: r.conditionType,
    conditionValue: r.conditionValue,
    actionType: r.actionType,
    isEnabled: r.isEnabled,
    createdAt: r.createdAt?.toISOString?.() || r.createdAt,
  }));
}

async function queryAutomationAlerts(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [eq(automationAlertsTable.tenantId, tenantId)];
  conditions.push(
    ...buildDateConditions(automationAlertsTable.createdAt, plan)
  );

  const rows = await db
    .select()
    .from(automationAlertsTable)
    .where(and(...conditions))
    .orderBy(desc(automationAlertsTable.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    campaignName: r.campaignName,
    conditionType: r.conditionType,
    conditionValue: r.conditionValue,
    actualValue: r.actualValue,
    actionType: r.actionType,
    actionTaken: r.actionTaken,
    isAcknowledged: r.isAcknowledged,
    createdAt: r.createdAt?.toISOString?.() || r.createdAt,
  }));
}

async function queryChangeLogs(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [eq(changeLogsTable.tenantId, tenantId)];
  conditions.push(
    ...buildDateConditions(changeLogsTable.date, plan, true)
  );
  const f = plan.filters || {};
  if (f.category) conditions.push(eq(changeLogsTable.category, String(f.category)));

  const rows = await db
    .select()
    .from(changeLogsTable)
    .where(and(...conditions))
    .orderBy(desc(changeLogsTable.date))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    title: r.title,
    description: r.description,
    category: r.category,
  }));
}

async function queryCallAttempts(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const leadIds = await getLeadIdsForTenant(tenantId);
  if (leadIds.length === 0) return [];

  const conditions: SQL[] = [inArray(callAttemptsTable.leadId, leadIds)];
  conditions.push(
    ...buildDateConditions(callAttemptsTable.attemptedAt, plan)
  );

  const rows = await db
    .select()
    .from(callAttemptsTable)
    .where(and(...conditions))
    .orderBy(desc(callAttemptsTable.attemptedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    leadId: r.leadId,
    method: r.method,
    outcome: r.outcome,
    platform: r.platform,
    attemptedAt: r.attemptedAt?.toISOString?.() || r.attemptedAt,
    notes: r.notes,
  }));
}

async function queryScheduledFollowups(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const leadIds = await getLeadIdsForTenant(tenantId);
  if (leadIds.length === 0) return [];

  const conditions: SQL[] = [inArray(scheduledFollowupsTable.leadId, leadIds)];
  const f = plan.filters || {};
  if (f.completed !== undefined)
    conditions.push(eq(scheduledFollowupsTable.completed, Boolean(f.completed)));

  const rows = await db
    .select()
    .from(scheduledFollowupsTable)
    .where(and(...conditions))
    .orderBy(desc(scheduledFollowupsTable.scheduledFor))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    leadId: r.leadId,
    reason: r.reason,
    scheduledFor: r.scheduledFor?.toISOString?.() || r.scheduledFor,
    completed: r.completed,
  }));
}

async function queryIntegrationSyncLogs(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [
    eq(integrationSyncLogsTable.tenantId, tenantId),
  ];
  conditions.push(
    ...buildDateConditions(integrationSyncLogsTable.createdAt, plan)
  );

  const rows = await db
    .select()
    .from(integrationSyncLogsTable)
    .where(and(...conditions))
    .orderBy(desc(integrationSyncLogsTable.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    integration: r.integration,
    syncType: r.syncType,
    status: r.status,
    recordsProcessed: r.recordsProcessed,
    errorMessage: r.errorMessage,
    startedAt: r.startedAt?.toISOString?.() || r.startedAt,
    completedAt: r.completedAt?.toISOString?.() || r.completedAt,
  }));
}

async function queryUsers(
  tenantId: number,
  plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [eq(usersTable.tenantId, tenantId)];

  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(and(...conditions))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    createdAt: r.createdAt?.toISOString?.() || r.createdAt,
  }));
}

async function queryFunnelTypes(
  _tenantId: number,
  _plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const conditions: SQL[] = [];
  const f = _plan.filters || {};
  if (f.isActive !== undefined) conditions.push(eq(funnelTypesTable.isActive, Boolean(f.isActive)));

  const rows = await db
    .select()
    .from(funnelTypesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    isActive: r.isActive,
    createdAt: r.createdAt?.toISOString?.() || r.createdAt,
  }));
}

async function queryTenantFunnelTypes(
  tenantId: number,
  _plan: QueryPlan,
  limit: number
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select({
      tenantId: tenantFunnelTypesTable.tenantId,
      funnelTypeId: tenantFunnelTypesTable.funnelTypeId,
      funnelName: funnelTypesTable.name,
      funnelSlug: funnelTypesTable.slug,
      funnelDescription: funnelTypesTable.description,
      isActive: funnelTypesTable.isActive,
      createdAt: tenantFunnelTypesTable.createdAt,
    })
    .from(tenantFunnelTypesTable)
    .innerJoin(funnelTypesTable, eq(tenantFunnelTypesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId))
    .limit(limit);

  return rows.map((r) => ({
    tenantId: r.tenantId,
    funnelTypeId: r.funnelTypeId,
    funnelName: r.funnelName,
    funnelSlug: r.funnelSlug,
    funnelDescription: r.funnelDescription,
    isActive: r.isActive,
    createdAt: r.createdAt?.toISOString?.() || r.createdAt,
  }));
}

async function computeMetrics(
  tenantId: number,
  plan: QueryPlan
): Promise<Record<string, unknown>[]> {
  const metrics = plan.computedMetrics || [];
  const result: Record<string, unknown> = {};

  const campaignIds = await getCampaignIdsForTenant(tenantId);
  const dateConditionsLeads: SQL[] = [eq(leadsTable.tenantId, tenantId)];
  const dateConditionsStats: SQL[] =
    campaignIds.length > 0
      ? [inArray(campaignDailyStatsTable.campaignId, campaignIds)]
      : [];
  const dateConditionsJobs: SQL[] = [
    eq(jobsTable.tenantId, tenantId),
    eq(jobsTable.status, "completed"),
  ];

  if (plan.dateRange) {
    if (plan.dateRange.start) {
      dateConditionsLeads.push(
        gte(leadsTable.createdAt, new Date(plan.dateRange.start))
      );
      if (campaignIds.length > 0)
        dateConditionsStats.push(
          gte(campaignDailyStatsTable.date, plan.dateRange.start)
        );
      dateConditionsJobs.push(
        gte(jobsTable.completedAt, new Date(plan.dateRange.start))
      );
    }
    if (plan.dateRange.end) {
      dateConditionsLeads.push(
        lte(leadsTable.createdAt, new Date(plan.dateRange.end))
      );
      if (campaignIds.length > 0)
        dateConditionsStats.push(
          lte(campaignDailyStatsTable.date, plan.dateRange.end)
        );
      dateConditionsJobs.push(
        lte(jobsTable.completedAt, new Date(plan.dateRange.end))
      );
    }
  }

  let totalLeads = 0;
  let bookedLeads = 0;
  let soldLeads = 0;
  let totalSpend = 0;
  let totalClicks = 0;
  let totalImpressions = 0;
  let totalRevenue = 0;
  let jobCount = 0;

  const needsLeads = metrics.some((m) =>
    ["cpl", "booking_rate", "close_rate", "lead_count"].includes(m)
  );
  const needsSpend = metrics.some((m) =>
    ["cpl", "roas", "total_spend", "cpc", "ctr"].includes(m)
  );
  const needsRevenue = metrics.some((m) =>
    ["roas", "total_revenue", "avg_job_value"].includes(m)
  );

  if (needsLeads) {
    const leads = await db
      .select()
      .from(leadsTable)
      .where(and(...dateConditionsLeads));
    totalLeads = leads.length;
    bookedLeads = leads.filter(
      (l) => l.status === "booked" || l.status === "sold"
    ).length;
    soldLeads = leads.filter((l) => l.status === "sold").length;
  }

  if (needsSpend && campaignIds.length > 0) {
    const stats = await db
      .select()
      .from(campaignDailyStatsTable)
      .where(and(...dateConditionsStats));
    totalSpend = stats.reduce((s, r) => s + (r.spend || 0), 0);
    totalClicks = stats.reduce((s, r) => s + (r.clicks || 0), 0);
    totalImpressions = stats.reduce((s, r) => s + (r.impressions || 0), 0);
  }

  if (needsRevenue) {
    const jobs = await db
      .select()
      .from(jobsTable)
      .where(and(...dateConditionsJobs));
    totalRevenue = jobs.reduce((s, j) => s + (j.revenue || 0), 0);
    jobCount = jobs.length;
  }

  for (const metric of metrics) {
    switch (metric) {
      case "cpl":
        result.cpl =
          totalLeads > 0
            ? Math.round((totalSpend / totalLeads) * 100) / 100
            : 0;
        result.totalSpend = Math.round(totalSpend * 100) / 100;
        result.totalLeads = totalLeads;
        break;
      case "roas":
        result.roas =
          totalSpend > 0
            ? Math.round((totalRevenue / totalSpend) * 10) / 10
            : 0;
        result.totalRevenue = Math.round(totalRevenue * 100) / 100;
        result.totalSpend = Math.round(totalSpend * 100) / 100;
        break;
      case "booking_rate":
        result.bookingRate =
          totalLeads > 0
            ? Math.round((bookedLeads / totalLeads) * 1000) / 10
            : 0;
        result.bookedLeads = bookedLeads;
        result.totalLeads = totalLeads;
        break;
      case "close_rate":
        result.closeRate =
          bookedLeads > 0
            ? Math.round((soldLeads / bookedLeads) * 1000) / 10
            : 0;
        result.soldLeads = soldLeads;
        result.bookedLeads = bookedLeads;
        break;
      case "cpc":
        result.cpc =
          totalClicks > 0
            ? Math.round((totalSpend / totalClicks) * 100) / 100
            : 0;
        result.totalSpend = Math.round(totalSpend * 100) / 100;
        result.totalClicks = totalClicks;
        break;
      case "ctr":
        result.ctr =
          totalImpressions > 0
            ? Math.round((totalClicks / totalImpressions) * 10000) / 100
            : 0;
        result.totalClicks = totalClicks;
        result.totalImpressions = totalImpressions;
        break;
      case "total_spend":
        result.totalSpend = Math.round(totalSpend * 100) / 100;
        break;
      case "total_revenue":
        result.totalRevenue = Math.round(totalRevenue * 100) / 100;
        result.jobCount = jobCount;
        break;
      case "avg_job_value":
        result.avgJobValue =
          jobCount > 0
            ? Math.round((totalRevenue / jobCount) * 100) / 100
            : 0;
        result.jobCount = jobCount;
        break;
      case "lead_count":
        result.totalLeads = totalLeads;
        result.bookedLeads = bookedLeads;
        result.soldLeads = soldLeads;
        break;
    }
  }

  return Object.keys(result).length > 0 ? [result] : [];
}
