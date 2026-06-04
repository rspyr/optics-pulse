import { Router, type IRouter } from "express";
import { db, leadsTable, callAttemptsTable, podiumMessagesTable, funnelTypesTable, leadMergesTable, attributionEventsTable, leadAttributionCorrectionsTable, tenantFunnelTypesTable, jobsTable } from "@workspace/db";
import { eq, and, count, desc, sql, SQL, inArray, gte, lte } from "drizzle-orm";
import { markEventManuallyMatched, reDeriveLeadFunnel, redetectAndPersistEvent } from "../services/re-derive-lead-funnel";
import { reRouteLeadsAfterAttributionChange } from "../services/lead-rerouting";
import { ListLeadsQueryParams, GetLeadParams, UpdateLeadBody } from "@workspace/api-zod";
import { getHudStats, emitLeadUpdated } from "../socket";
import { initiateCall, initiateText, getTenantCommConfig, getCommConfigStatus } from "../services/integrations/communication";
import { getSmartQueue } from "../services/lead-scoring";
import { getComparisonStats, getHistoricalStats, aggregateDailyStats } from "../services/coordinator-stats";
import type { ComparisonBaseline } from "../services/coordinator-stats";
import { parseFilterQuery } from "../services/parse-filter";
import { resolveListTenantScope, assertResourceTenantAccess } from "../lib/tenant-scope";
import { resetBookingCache } from "../services/lead-booking-cache";

const router: IRouter = Router();

router.post("/leads/parse-filter", async (req, res) => {
  const { query } = req.body as { query?: string };

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    res.status(400).json({ error: "Query is required" });
    return;
  }

  if (query.length > 500) {
    res.status(400).json({ error: "Query too long" });
    return;
  }

  const role = req.session.userRole;
  const bodyTenantId = (req.body as { tenantId?: number }).tenantId;
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : undefined;
  const requestedTenantId = bodyTenantId || queryTenantId;
  const tenantId = (role === "super_admin" || role === "agency_user")
    ? (requestedTenantId || req.session.tenantId || 1)
    : req.session.tenantId || 1;

  try {
    const [sourcesResult, leadTypesResult, statusesResult, salespeopleResult, dispositionsResult] = await Promise.all([
      db.selectDistinct({ value: leadsTable.source }).from(leadsTable).where(eq(leadsTable.tenantId, tenantId)),
      db.selectDistinct({ value: leadsTable.leadType }).from(leadsTable).where(eq(leadsTable.tenantId, tenantId)),
      db.selectDistinct({ value: leadsTable.status }).from(leadsTable).where(eq(leadsTable.tenantId, tenantId)),
      db.selectDistinct({ value: leadsTable.assignedTo }).from(leadsTable).where(eq(leadsTable.tenantId, tenantId)),
      db.selectDistinct({ value: leadsTable.disposition }).from(leadsTable).where(eq(leadsTable.tenantId, tenantId)),
    ]);

    const filters = await parseFilterQuery(query.trim(), {
      sources: sourcesResult.map(r => r.value).filter(Boolean).sort() as string[],
      leadTypes: leadTypesResult.map(r => r.value).filter(Boolean).sort() as string[],
      statuses: statusesResult.map(r => r.value).filter(Boolean).sort() as string[],
      salespeople: salespeopleResult.map(r => r.value).filter(Boolean).sort() as string[],
      dispositions: dispositionsResult.map(r => r.value).filter(Boolean).sort() as string[],
    });

    const isEmpty = Object.keys(filters).length === 0;
    res.json({ filters, empty: isEmpty });
  } catch (err) {
    console.error("[ParseFilter] Error:", err);
    res.status(500).json({ error: "Failed to parse filter query" });
  }
});

router.get("/leads", async (req, res) => {
  const query = ListLeadsQueryParams.parse(req.query);
  const conditions: SQL[] = [];

  const scope = resolveListTenantScope(req, res, query.tenantId, { requireTenant: true });
  if (!scope.ok) return;
  if (scope.tenantId) conditions.push(eq(leadsTable.tenantId, scope.tenantId));

  if (query.status) {
    const status = query.status as "new" | "contacted" | "booked" | "sold" | "lost" | "cancelled";
    conditions.push(eq(leadsTable.status, status));
  }
  if (query.source) conditions.push(eq(leadsTable.source, query.source));
  if (query.funnelId) conditions.push(eq(leadsTable.funnelId, query.funnelId));
  if (query.startDate) {
    const sd = new Date(query.startDate);
    if (!isNaN(sd.getTime())) conditions.push(gte(leadsTable.createdAt, sd));
  }
  if (query.endDate) {
    const ed = new Date(query.endDate);
    if (!isNaN(ed.getTime())) conditions.push(lte(leadsTable.createdAt, ed));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const [leads, [totalResult]] = await Promise.all([
    // Append the unique primary key as a deterministic tiebreaker so paging is
    // stable under LIMIT/OFFSET: createdAt ties leave rows the ORDER BY can't
    // distinguish, and Postgres gives no guaranteed order among them, so without
    // a unique secondary key adjacent pages can overlap or skip rows.
    db.select().from(leadsTable).where(where).orderBy(desc(leadsTable.createdAt), desc(leadsTable.id)).limit(limit).offset(offset),
    db.select({ count: count() }).from(leadsTable).where(where),
  ]);

  res.json({ leads, total: totalResult.count });
});

router.get("/leads/hud/queue", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  // requireTenant: the Pulse HUD is an inherently per-tenant view (there is no
  // cross-tenant queue in the product). An unfiltered admin request would run
  // getSmartQueue with no tenant filter — a cross-tenant scan + createdAt sort
  // over the whole leads table. Force a concrete tenant first.
  const scope = resolveListTenantScope(req, res, queryTenantId, { requireTenant: true });
  if (!scope.ok) return;
  const tenantId = scope.tenantId;

  try {
    const result = await getSmartQueue(tenantId);

    const newLeads = result.leads
      .filter(l => l.bucket === "new")
      .map(l => ({ ...l.lead, _suggestion: l.suggestion }));
    const followUps = result.leads
      .filter(l => l.bucket === "followup")
      .map(l => ({ ...l.lead, _suggestion: l.suggestion }));
    const background = result.leads
      .filter(l => l.bucket === "background")
      .map(l => ({ ...l.lead, _suggestion: l.suggestion }));

    res.json({
      newLeads,
      followUps,
      background,
      total: result.total,
    });
  } catch (err) {
    console.error("[Pulse Queue] Smart queue error, falling back:", err);
    const conditions: SQL[] = [];
    if (tenantId) conditions.push(eq(leadsTable.tenantId, tenantId));
    conditions.push(inArray(leadsTable.status, ["new", "contacted"]));
    const where = and(...conditions);
    const leads = await db.select().from(leadsTable).where(where).orderBy(desc(leadsTable.createdAt)).limit(100);
    const now = Date.now();
    res.json({
      newLeads: leads.filter(l => l.status === "new"),
      followUps: leads.filter(l => l.status === "contacted" && (now - new Date(l.updatedAt).getTime()) < 86400000),
      background: leads.filter(l => l.status === "contacted" && (now - new Date(l.updatedAt).getTime()) >= 86400000),
      total: leads.length,
    });
  }
});

router.get("/leads/hud/stats", async (req, res) => {
  const role = req.session.userRole;
  const isManager = role === "super_admin" || role === "agency_user" || role === "client_admin";
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  // requireTenant: the HUD stats are per-tenant. An unfiltered admin request
  // would aggregate counts across every tenant's leads/call_attempts for the
  // day — a cross-tenant scan. Force a concrete tenant first.
  const scope = resolveListTenantScope(req, res, queryTenantId, { requireTenant: true });
  if (!scope.ok) return;
  const tenantId = scope.tenantId;

  let csrId: number | null = null;
  if (role === "client_user") {
    csrId = (req.session as any)?.userId ?? null;
  } else if (req.query.csrId) {
    const parsed = Number(req.query.csrId);
    if (isManager && !isNaN(parsed)) {
      csrId = parsed;
    }
  }
  let startDate: Date | null = null;
  let endDate: Date | null = null;
  if (req.query.startDate) {
    const parsed = new Date(req.query.startDate as string);
    if (!isNaN(parsed.getTime())) startDate = parsed;
  }
  if (req.query.endDate) {
    const parsed = new Date(req.query.endDate as string);
    if (!isNaN(parsed.getTime())) endDate = parsed;
  }
  const stats = await getHudStats(tenantId, csrId, startDate, endDate);
  res.json(stats);
});

router.get("/leads/hud/comparison", async (req, res) => {
  const role = req.session.userRole;
  const isManager = role === "super_admin" || role === "agency_user";
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  // requireTenant: per-tenant HUD comparison. Force admins to pick a tenant
  // first rather than allowing the implicit cross-tenant path.
  const scope = resolveListTenantScope(req, res, queryTenantId, { requireTenant: true });
  if (!scope.ok) return;
  const tenantId = scope.tenantId;

  let userId: number | null = null;
  if (!isManager) {
    userId = req.session.userId ?? null;
  } else if (req.query.userId) {
    userId = Number(req.query.userId);
  }

  const baseline = (req.query.baseline as string) || "yesterday";
  const validBaselines = ["yesterday", "last_week", "monthly_avg", "all_time_best"];
  if (!validBaselines.includes(baseline)) {
    res.status(400).json({ error: `Invalid baseline. Must be one of: ${validBaselines.join(", ")}` });
    return;
  }

  try {
    const result = await getComparisonStats(
      tenantId,
      userId,
      baseline as ComparisonBaseline,
    );
    res.json(result);
  } catch (err) {
    console.error("[Pulse Comparison]", err);
    res.status(500).json({ error: "Failed to fetch comparison stats" });
  }
});

router.get("/leads/hud/historical", async (req, res) => {
  const role = req.session.userRole;
  const isManager = role === "super_admin" || role === "agency_user";
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  // requireTenant: per-tenant HUD history. An unfiltered admin request would
  // scan coordinator_daily_stats across every tenant for the date range. Force
  // a concrete tenant first.
  const scope = resolveListTenantScope(req, res, queryTenantId, { requireTenant: true });
  if (!scope.ok) return;
  const tenantId = scope.tenantId;

  let userId: number | null = null;
  if (!isManager) {
    userId = req.session.userId ?? null;
  } else if (req.query.userId) {
    userId = Number(req.query.userId);
  }

  const range = (req.query.range as string) || "30";
  const days = parseInt(range);
  const endDate = new Date().toISOString().split("T")[0];
  const startDateObj = new Date();
  startDateObj.setDate(startDateObj.getDate() - (isNaN(days) ? 30 : days));
  const startDate = (req.query.startDate as string) || startDateObj.toISOString().split("T")[0];
  const endDateParam = (req.query.endDate as string) || endDate;

  try {
    const result = await getHistoricalStats(tenantId, userId, startDate, endDateParam);
    res.json(result);
  } catch (err) {
    console.error("[Pulse Historical]", err);
    res.status(500).json({ error: "Failed to fetch historical stats" });
  }
});

router.post("/leads/hud/aggregate", async (req, res) => {
  const role = req.session.userRole;
  if (role !== "super_admin" && role !== "agency_user") {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  const dateStr = (req.body.date as string) || new Date().toISOString().split("T")[0];
  try {
    const count = await aggregateDailyStats(dateStr);
    res.json({ success: true, coordinatorsProcessed: count, date: dateStr });
  } catch (err) {
    console.error("[Aggregate]", err);
    res.status(500).json({ error: "Aggregation failed" });
  }
});

router.get("/leads/comm-config", async (req, res) => {
  const role = req.session.userRole;
  const tenantId = (role === "super_admin" || role === "agency_user")
    ? (req.query.tenantId ? Number(req.query.tenantId) : null)
    : req.session.tenantId ?? null;

  if (!tenantId) {
    res.json({
      callPlatform: "native",
      textPlatform: "native",
      callReady: true,
      textReady: true,
      callStatusMessage: "Using native phone dialer",
      textStatusMessage: "Using native SMS app",
    });
    return;
  }

  try {
    const config = await getTenantCommConfig(tenantId);
    const status = getCommConfigStatus(config);
    res.json(status);
  } catch (err) {
    res.json({
      callPlatform: "native",
      textPlatform: "native",
      callReady: true,
      textReady: true,
      callStatusMessage: "Using native phone dialer",
      textStatusMessage: "Using native SMS app",
    });
  }
});

function parseNaturalDate(input: string): { start: Date; end: Date; remainingText: string } | null {
  const trimmed = input.trim();
  const now = new Date();
  const currentYear = now.getFullYear();

  const monthNames: Record<string, number> = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
    april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
    august: 7, aug: 7, september: 8, sep: 8, sept: 8,
    october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  };

  let month: number | null = null;
  let day: number | null = null;
  let year: number = currentYear;
  let matchedPortion = "";

  const slashDash = trimmed.match(/(^|\s)(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?(?=\s|$)/);
  if (slashDash) {
    month = parseInt(slashDash[2], 10) - 1;
    day = parseInt(slashDash[3], 10);
    if (slashDash[4]) {
      year = parseInt(slashDash[4], 10);
      if (year < 100) year += 2000;
    }
    matchedPortion = slashDash[0];
  }

  if (month === null) {
    const monthNamesPattern = Object.keys(monthNames).join("|");
    const wordDateRegex = new RegExp(
      `(^|\\s)(${monthNamesPattern})\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{2,4}))?(?=\\s|$)`,
      "i"
    );
    const wordDate = trimmed.match(wordDateRegex);
    if (wordDate) {
      const monthKey = wordDate[2].toLowerCase();
      if (monthKey in monthNames) {
        month = monthNames[monthKey];
        day = parseInt(wordDate[3], 10);
        if (wordDate[4]) {
          year = parseInt(wordDate[4], 10);
          if (year < 100) year += 2000;
        }
        matchedPortion = wordDate[0];
      }
    }
  }

  if (month === null || day === null) return null;
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;

  const start = new Date(year, month, day, 0, 0, 0, 0);
  if (isNaN(start.getTime())) return null;
  if (start.getMonth() !== month || start.getDate() !== day) return null;

  const end = new Date(year, month, day, 23, 59, 59, 999);

  const remainingText = trimmed.replace(matchedPortion, " ").replace(/\s+/g, " ").trim();

  return { start, end, remainingText };
}

router.get("/leads/search", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  // Deliberately NOT opted into `{ requireTenant: true }`: unlike the heavy
  // list/drilldown endpoints, this handler can never run an unfiltered
  // cross-tenant query. It resolves to a single concrete tenant (the supplied
  // tenantId, else the caller's session tenantId) and short-circuits to an
  // empty result when none is available — so a super_admin / agency_user with
  // no tenantId simply gets `{ leads: [], total: 0 }`, never a full-table
  // scan. Every query below is hard-scoped with `eq(leads.tenantId, ...)`, and
  // the session-tenant fallback is intentional (an admin with a session tenant
  // can search it without re-supplying tenantId), which `requireTenant` would
  // break by 400-ing before the fallback runs.
  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;
  const resolvedTenantId = scope.tenantId ?? req.session.tenantId ?? null;

  if (!resolvedTenantId) {
    res.json({ leads: [], total: 0 });
    return;
  }

  const q = ((req.query.q as string) || "").trim();
  const funnelId = req.query.funnelId ? Number(req.query.funnelId) : null;
  const dateType = (req.query.dateType as string) === "lastTouchpoint" ? "lastTouchpoint" : "created";
  const startDate = req.query.startDate ? new Date(req.query.startDate as string) : null;
  const endDate = req.query.endDate ? new Date(req.query.endDate as string) : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  let validStartDate = startDate && !isNaN(startDate.getTime()) ? startDate : null;
  let validEndDate = endDate && !isNaN(endDate.getTime()) ? endDate : null;

  let textQuery = q;
  if (q && !validStartDate && !validEndDate) {
    const parsed = parseNaturalDate(q);
    if (parsed) {
      validStartDate = parsed.start;
      validEndDate = parsed.end;
      textQuery = parsed.remainingText;
      console.log(`[LeadSearch] parsed natural date from q="${q}": ${parsed.start.toISOString()} - ${parsed.end.toISOString()}, remaining text="${textQuery}"`);
    }
  }

  console.log(`[LeadSearch] tenant=${resolvedTenantId} q="${textQuery}" funnelId=${funnelId} dateType=${dateType} startDate=${validStartDate?.toISOString() ?? "null"} endDate=${validEndDate?.toISOString() ?? "null"}`);

  if (!textQuery && !funnelId && !validStartDate && !validEndDate) {
    console.log("[LeadSearch] No search criteria provided, returning empty");
    res.json({ leads: [], total: 0 });
    return;
  }

  try {
    const conditions: SQL[] = [eq(leadsTable.tenantId, resolvedTenantId)];

    if (funnelId) {
      conditions.push(eq(leadsTable.funnelId, funnelId));
    }

    const digitsOnly = textQuery.replace(/\D/g, "");
    const isPhoneSearch = digitsOnly.length >= 1 && digitsOnly.length <= 15;

    let relevanceExpr: SQL;
    if (textQuery) {
      const fuzzyConditions: SQL[] = [];

      fuzzyConditions.push(
        sql`(${leadsTable.firstName} % ${textQuery} OR ${leadsTable.lastName} % ${textQuery} OR (COALESCE(${leadsTable.firstName}, '') || ' ' || COALESCE(${leadsTable.lastName}, '')) % ${textQuery})`
      );

      fuzzyConditions.push(
        sql`(${leadsTable.email} IS NOT NULL AND ${leadsTable.email} % ${textQuery})`
      );

      if (isPhoneSearch) {
        // leads.phone is stored in canonical (digits-only, leading "1"
        // stripped) form, so we can compare against the bare column. A full
        // 10-digit input goes through equality (index-friendly); shorter
        // inputs fall back to a substring LIKE on the canonical column.
        if (digitsOnly.length >= 10) {
          const normalized = digitsOnly.length === 11 && digitsOnly.startsWith("1")
            ? digitsOnly.slice(1)
            : digitsOnly.slice(-10);
          fuzzyConditions.push(
            sql`(${leadsTable.phone} IS NOT NULL AND ${leadsTable.phone} = ${normalized})`
          );
        } else {
          fuzzyConditions.push(
            sql`(${leadsTable.phone} IS NOT NULL AND ${leadsTable.phone} LIKE '%' || ${digitsOnly} || '%')`
          );
        }
      }

      fuzzyConditions.push(
        sql`(LOWER(COALESCE(${leadsTable.firstName}, '')) LIKE LOWER(${`%${textQuery}%`}) OR LOWER(COALESCE(${leadsTable.lastName}, '')) LIKE LOWER(${`%${textQuery}%`}))`
      );

      fuzzyConditions.push(
        sql`(${leadsTable.email} IS NOT NULL AND LOWER(${leadsTable.email}) LIKE LOWER(${`%${textQuery}%`}))`
      );

      fuzzyConditions.push(
        sql`(${funnelTypesTable.name} IS NOT NULL AND ${funnelTypesTable.name} % ${textQuery})`
      );

      fuzzyConditions.push(
        sql`(${funnelTypesTable.name} IS NOT NULL AND LOWER(${funnelTypesTable.name}) LIKE LOWER(${`%${textQuery}%`}))`
      );

      conditions.push(sql`(${sql.join(fuzzyConditions, sql` OR `)})`);

      relevanceExpr = sql`(
        GREATEST(
          COALESCE(similarity(${leadsTable.firstName}, ${textQuery}), 0),
          COALESCE(similarity(${leadsTable.lastName}, ${textQuery}), 0),
          COALESCE(similarity(COALESCE(${leadsTable.firstName}, '') || ' ' || COALESCE(${leadsTable.lastName}, ''), ${textQuery}), 0),
          COALESCE(similarity(${leadsTable.email}, ${textQuery}), 0),
          CASE WHEN ${leadsTable.phone} IS NOT NULL AND ${leadsTable.phone} LIKE '%' || ${digitsOnly} || '%' THEN 0.8 ELSE 0 END,
          CASE WHEN LOWER(COALESCE(${leadsTable.firstName}, '')) LIKE LOWER(${`%${textQuery}%`}) OR LOWER(COALESCE(${leadsTable.lastName}, '')) LIKE LOWER(${`%${textQuery}%`}) THEN 0.5 ELSE 0 END,
          CASE WHEN ${leadsTable.email} IS NOT NULL AND LOWER(${leadsTable.email}) LIKE LOWER(${`%${textQuery}%`}) THEN 0.5 ELSE 0 END,
          COALESCE(similarity(${funnelTypesTable.name}, ${textQuery}), 0),
          CASE WHEN ${funnelTypesTable.name} IS NOT NULL AND LOWER(${funnelTypesTable.name}) LIKE LOWER(${`%${textQuery}%`}) THEN 0.5 ELSE 0 END
        )
      )`;
    } else {
      relevanceExpr = sql`1`;
    }

    if (dateType === "created") {
      if (validStartDate) {
        conditions.push(gte(leadsTable.createdAt, validStartDate));
      }
      if (validEndDate) {
        conditions.push(lte(leadsTable.createdAt, validEndDate));
      }
    }

    const where = and(...conditions);

    if (dateType === "lastTouchpoint" && (validStartDate || validEndDate)) {
      const lastTouchpointExpr = sql`GREATEST(
        COALESCE((SELECT MAX(ca.attempted_at) FROM call_attempts ca WHERE ca.lead_id = ${leadsTable.id}), '1970-01-01'::timestamp),
        COALESCE((SELECT MAX(COALESCE(pm.podium_created_at, pm.created_at)) FROM podium_messages pm WHERE pm.lead_id = ${leadsTable.id}), '1970-01-01'::timestamp)
      )`;

      const touchpointConds: SQL[] = [...conditions];
      if (validStartDate) {
        touchpointConds.push(sql`${lastTouchpointExpr} >= ${validStartDate}`);
      }
      if (validEndDate) {
        touchpointConds.push(sql`${lastTouchpointExpr} <= ${validEndDate}`);
      }
      const tpWhere = and(...touchpointConds);

      const orderExpr = textQuery ? desc(sql`relevance`) : desc(sql`last_touchpoint`);

      const [leads, [totalResult]] = await Promise.all([
        db
          .select({
            id: leadsTable.id,
            tenantId: leadsTable.tenantId,
            firstName: leadsTable.firstName,
            lastName: leadsTable.lastName,
            phone: leadsTable.phone,
            email: leadsTable.email,
            source: leadsTable.source,
            originalSource: leadsTable.originalSource,
            leadType: leadsTable.leadType,
            interestType: leadsTable.interestType,
            status: leadsTable.status,
            hubStatus: leadsTable.hubStatus,
            dayInSequence: leadsTable.dayInSequence,
            contactPreferences: leadsTable.contactPreferences,
            serviceType: leadsTable.serviceType,
            funnelId: leadsTable.funnelId,
            assignedCsrId: leadsTable.assignedCsrId,
            callbackAt: leadsTable.callbackAt,
            deadReason: leadsTable.deadReason,
            disposition: leadsTable.disposition,
            notes: leadsTable.notes,
            address: leadsTable.address,
            city: leadsTable.city,
            state: leadsTable.state,
            zip: leadsTable.zip,
            appointmentDate: leadsTable.appointmentDate,
            appointmentTime: leadsTable.appointmentTime,
            createdAt: leadsTable.createdAt,
            updatedAt: leadsTable.updatedAt,
            relevance: relevanceExpr.as("relevance"),
            lastTouchpoint: lastTouchpointExpr.as("last_touchpoint"),
          })
          .from(leadsTable)
          .leftJoin(funnelTypesTable, eq(leadsTable.funnelId, funnelTypesTable.id))
          .where(tpWhere)
          .orderBy(orderExpr, desc(leadsTable.createdAt), desc(leadsTable.id))
          .limit(limit)
          .offset(offset),
        db.select({ count: count() }).from(leadsTable).leftJoin(funnelTypesTable, eq(leadsTable.funnelId, funnelTypesTable.id)).where(tpWhere),
      ]);

      console.log(`[LeadSearch] lastTouchpoint query returned ${leads.length} of ${totalResult.count} total`);
      res.json({ leads, total: totalResult.count });
      return;
    }

    const [leads, [totalResult]] = await Promise.all([
      db
        .select({
          id: leadsTable.id,
          tenantId: leadsTable.tenantId,
          firstName: leadsTable.firstName,
          lastName: leadsTable.lastName,
          phone: leadsTable.phone,
          email: leadsTable.email,
          source: leadsTable.source,
          originalSource: leadsTable.originalSource,
          leadType: leadsTable.leadType,
          interestType: leadsTable.interestType,
          status: leadsTable.status,
          hubStatus: leadsTable.hubStatus,
          dayInSequence: leadsTable.dayInSequence,
          contactPreferences: leadsTable.contactPreferences,
          serviceType: leadsTable.serviceType,
          funnelId: leadsTable.funnelId,
          assignedCsrId: leadsTable.assignedCsrId,
          callbackAt: leadsTable.callbackAt,
          deadReason: leadsTable.deadReason,
          disposition: leadsTable.disposition,
          notes: leadsTable.notes,
          address: leadsTable.address,
          city: leadsTable.city,
          state: leadsTable.state,
          zip: leadsTable.zip,
          appointmentDate: leadsTable.appointmentDate,
          appointmentTime: leadsTable.appointmentTime,
          createdAt: leadsTable.createdAt,
          updatedAt: leadsTable.updatedAt,
          relevance: relevanceExpr.as("relevance"),
        })
        .from(leadsTable)
        .leftJoin(funnelTypesTable, eq(leadsTable.funnelId, funnelTypesTable.id))
        .where(where)
        .orderBy(textQuery ? desc(sql`relevance`) : desc(leadsTable.createdAt), desc(leadsTable.createdAt), desc(leadsTable.id))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(leadsTable).leftJoin(funnelTypesTable, eq(leadsTable.funnelId, funnelTypesTable.id)).where(where),
    ]);

    console.log(`[LeadSearch] query returned ${leads.length} of ${totalResult.count} total`);
    res.json({ leads, total: totalResult.count });
  } catch (err) {
    console.error("[LeadSearch] Error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

router.get("/leads/:leadId", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) {
    // The lead row may have been hard-deleted by the dedupe cleanup script.
    // If so, point the caller at the canonical lead it was merged into so
    // support tools can answer "what happened to lead #1234?".
    const [merge] = await db
      .select()
      .from(leadMergesTable)
      .where(eq(leadMergesTable.duplicateLeadId, leadId));
    if (merge) {
      const access = assertResourceTenantAccess(req, res, merge.tenantId);
      if (!access.ok) return;
      res.status(410).json({
        error: "Lead was merged",
        mergedInto: {
          canonicalLeadId: merge.canonicalLeadId,
          mergedAt: merge.mergedAt,
          source: merge.source,
          runId: merge.runId,
        },
      });
      return;
    }
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const access = assertResourceTenantAccess(req, res, lead.tenantId);
  if (!access.ok) return;
  res.json(lead);
});

router.get("/leads/:leadId/invoice", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const [lead] = await db
    .select({ tenantId: leadsTable.tenantId })
    .from(leadsTable)
    .where(eq(leadsTable.id, leadId));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const access = assertResourceTenantAccess(req, res, lead.tenantId);
  if (!access.ok) return;

  // Pick the most recent invoiced job linked to this lead. A lead can map
  // to multiple jobs in ServiceTitan (e.g. revisit, warranty), so we prefer
  // the latest invoice and fall back to the latest job date when an invoice
  // date is missing.
  const [job] = await db
    .select({
      jobId: jobsTable.id,
      stJobId: jobsTable.stJobId,
      stInvoiceId: jobsTable.stInvoiceId,
      stJobNumber: jobsTable.stJobNumber,
      invoiceDate: jobsTable.invoiceDate,
      invoiceTotal: jobsTable.invoiceTotal,
      invoicePaidAmount: jobsTable.invoicePaidAmount,
      invoicePaidOn: jobsTable.invoicePaidOn,
      invoiceBalance: jobsTable.invoiceBalance,
      invoiceRebateAmount: jobsTable.invoiceRebateAmount,
      customerName: jobsTable.customerName,
      customerPhone: jobsTable.customerPhone,
      customerEmail: jobsTable.customerEmail,
      serviceAddress: jobsTable.serviceAddress,
      jobTypeName: jobsTable.jobTypeName,
      hasInvoice: jobsTable.hasInvoice,
      matchLevel: jobsTable.matchLevel,
      completedAt: jobsTable.completedAt,
    })
    .from(jobsTable)
    .where(and(
      eq(jobsTable.leadId, leadId),
      eq(jobsTable.hasInvoice, true),
    ))
    .orderBy(desc(sql`COALESCE(${jobsTable.invoiceDate}, ${jobsTable.completedAt})`))
    .limit(1);

  if (!job) {
    res.status(404).json({ error: "No invoice found for this lead" });
    return;
  }
  res.json(job);
});

router.get("/leads/:leadId/merges", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });

  // Authorize against either the surviving lead (if still present) or the
  // recorded merge row (if the requested id is a deleted duplicate).
  let tenantId: number | null = null;
  const [lead] = await db
    .select({ tenantId: leadsTable.tenantId })
    .from(leadsTable)
    .where(eq(leadsTable.id, leadId));
  if (lead) {
    tenantId = lead.tenantId;
  } else {
    const [merge] = await db
      .select({ tenantId: leadMergesTable.tenantId })
      .from(leadMergesTable)
      .where(eq(leadMergesTable.duplicateLeadId, leadId));
    if (merge) tenantId = merge.tenantId;
  }
  if (tenantId === null) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const access = assertResourceTenantAccess(req, res, tenantId);
  if (!access.ok) return;

  const [duplicates, mergedIntoRows] = await Promise.all([
    db
      .select()
      .from(leadMergesTable)
      .where(eq(leadMergesTable.canonicalLeadId, leadId))
      .orderBy(desc(leadMergesTable.mergedAt)),
    db
      .select()
      .from(leadMergesTable)
      .where(eq(leadMergesTable.duplicateLeadId, leadId)),
  ]);

  res.json({
    duplicates: duplicates.map((m) => ({
      duplicateLeadId: m.duplicateLeadId,
      mergedAt: m.mergedAt,
      source: m.source,
      runId: m.runId,
    })),
    mergedInto: mergedIntoRows[0]
      ? {
          canonicalLeadId: mergedIntoRows[0].canonicalLeadId,
          mergedAt: mergedIntoRows[0].mergedAt,
          source: mergedIntoRows[0].source,
          runId: mergedIntoRows[0].runId,
        }
      : null,
  });
});

router.patch("/leads/:leadId", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const [existingLead] = await db.select({
    tenantId: leadsTable.tenantId,
    bookedAt: leadsTable.bookedAt,
    status: leadsTable.status,
    hubStatus: leadsTable.hubStatus,
  }).from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!existingLead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const access = assertResourceTenantAccess(req, res, existingLead.tenantId);
  if (!access.ok) return;
  const body = UpdateLeadBody.parse(req.body);
  const updateData: Partial<typeof leadsTable.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
  const now = new Date();
  // A booking event happens whenever the lead transitions *into* booked/sold
  // from a non-booked/sold status — including re-books after the lead was
  // moved back out. The history table must capture every such event for
  // accurate metrics; bookedAt remains a one-shot denormalized cache of the
  // first booking moment.
  const becameBooked =
    !!body.status &&
    (body.status === "booked" || body.status === "sold") &&
    existingLead.status !== "booked" &&
    existingLead.status !== "sold";
  const becameUnbooked =
    !!body.status &&
    body.status !== "booked" &&
    body.status !== "sold" &&
    (existingLead.status === "booked" || existingLead.status === "sold");
  if (body.status) {
    updateData.status = body.status as "new" | "contacted" | "booked" | "sold" | "lost" | "cancelled";
    // Task #413: stamp bookedAt when this PATCH is the path that *first*
    // transitions the lead into booked/sold so daily booking attribution is
    // anchored to the booking moment, not the row's last-touched timestamp.
    if (becameBooked && !existingLead.bookedAt) {
      updateData.bookedAt = now;
    }
    // Task #432: when this PATCH moves the lead OUT of booked/sold,
    // fully reset the denormalized booking cache (disposition,
    // bookedByCsrId, bookedAt) so the lead leaves the {booked, sold}
    // aggregate window used by `getBookingStatsByIdsAndDate` and so a
    // future re-book through any path can't pick up stale per-CSR
    // attribution from the prior booker.
    if (becameUnbooked) {
      resetBookingCache(updateData, existingLead);
    }
  }
  if (body.assignedTo) updateData.assignedTo = body.assignedTo;
  // Task #432: skip caller-supplied disposition on an un-book transition
  // so it can't undo the booking-cache reset above. A caller un-booking
  // a lead shouldn't be able to leave a stale 'booked' disposition on
  // the row.
  if (body.disposition && !becameUnbooked) updateData.disposition = body.disposition;

  const [lead] = await db.update(leadsTable).set(updateData).where(eq(leadsTable.id, leadId)).returning();
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  // Task #416: record every status transition routed through this endpoint
  // so the audit log is complete and coordinator-stats booking counts (now
  // history-anchored) include bookings made via PATCH /leads/:leadId. When
  // the patch produces a new booking we emit an `appt_set` row — that's the
  // toStatus the booking-stats query keys on — using the freshly stamped
  // bookedAt as the transition time. Other status changes are logged with
  // their literal `status` values for general audit completeness.
  if (body.status && body.status !== existingLead.status) {
    const { recordLeadStatusChange } = await import("../services/lead-status-history");
    if (becameBooked) {
      // Booking event: emit `appt_set` so coordinator-stats (history-anchored
      // on toStatus='appt_set') counts every booking, including re-books that
      // happen after the lead had already been booked once before. We key
      // fromStatus off the lead's legacy `status` field (the column actually
      // being mutated here) rather than `hubStatus`, otherwise a stale
      // `hubStatus='appt_set'` from a prior booking would collide with the
      // new toStatus and the helper's no-op guard would silently drop the
      // re-book row.
      await recordLeadStatusChange({
        leadId,
        tenantId: existingLead.tenantId,
        fromStatus: existingLead.status,
        toStatus: "appt_set",
        changedAt: now,
        changedByUserId: req.session.userId ?? null,
        reason: `patch_lead_status:${body.status}`,
      });
    } else {
      await recordLeadStatusChange({
        leadId,
        tenantId: existingLead.tenantId,
        fromStatus: existingLead.status,
        toStatus: body.status,
        changedByUserId: req.session.userId ?? null,
        reason: "patch_lead_status",
      });
    }
  }

  if (body.disposition && req.session.userId) {
    const dispositionToOutcome: Record<string, string> = {
      booked: "answered",
      callback_requested: "answered",
      not_interested: "answered",
      never_answered: "no_answer",
      out_of_area: "answered",
      looking_for_job: "answered",
      already_had_estimate: "answered",
      dont_remember: "answered",
    };
    const outcome = dispositionToOutcome[body.disposition] || "answered";
    try {
      const { logAttemptWithFollowup } = await import("../services/lead-scoring");
      await logAttemptWithFollowup(db, {
        leadId,
        userId: req.session.userId,
        method: "call",
        outcome,
        platform: "native",
        notes: `Disposition: ${body.disposition}`,
      });
      const { cancelAutoPass } = await import("../services/auto-pass-scheduler");
      cancelAutoPass(leadId);
    } catch (err) {
      console.error("[Leads] Auto-log call attempt on disposition failed:", err);
    }
  }

  emitLeadUpdated(lead.tenantId, lead as unknown as Record<string, unknown>);
  res.json(lead);
});

// Task #549: per-lead funnel override. Setting an override pins the lead's
// funnelId / leadType / serviceType and stamps `funnel_overridden_at` so the
// alias re-resolve and rule-rederive paths leave the row alone. Used by the
// "Resolved Identity" panel's "Just this lead" save mode so an operator can
// fix one lead's funnel without retagging every lead in the tenant that
// matches the same alias.
router.post("/leads/:leadId/funnel-override", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const userId = req.session.userId;
  const body = req.body as { funnelTypeId?: number; attributionEventId?: number };
  const funnelTypeId = Number(body.funnelTypeId);
  if (!Number.isFinite(funnelTypeId) || funnelTypeId <= 0) {
    res.status(400).json({ error: "funnelTypeId is required" });
    return;
  }

  const [existingLead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!existingLead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const role = req.session.userRole;
  if (role !== "super_admin" && role !== "agency_user") {
    if (existingLead.tenantId !== req.session.tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  const [funnelType] = await db.select({ id: funnelTypesTable.id, name: funnelTypesTable.name })
    .from(funnelTypesTable).where(eq(funnelTypesTable.id, funnelTypeId)).limit(1);
  if (!funnelType) {
    res.status(400).json({ error: "Unknown funnelTypeId" });
    return;
  }
  const [tenantAssoc] = await db.select().from(tenantFunnelTypesTable)
    .where(and(eq(tenantFunnelTypesTable.tenantId, existingLead.tenantId), eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId)));
  if (!tenantAssoc) {
    res.status(400).json({ error: "Funnel type is not enabled for this tenant" });
    return;
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(leadsTable).set({
      funnelId: funnelTypeId,
      leadType: funnelType.name,
      funnelOverriddenAt: now,
      funnelOverriddenByUserId: userId ?? null,
      updatedAt: now,
    }).where(eq(leadsTable.id, leadId));

    await tx.insert(leadAttributionCorrectionsTable).values({
      tenantId: existingLead.tenantId,
      leadId,
      field: "funnel",
      oldValue: existingLead.leadType,
      newValue: funnelType.name,
      changedByUserId: userId ?? null,
    });
  });

  // If the operator was viewing an attribution event when they made the
  // override, persist the canonical funnel on that event row too so the
  // drawer refetch reflects the new value immediately. Tenant-scoped.
  if (typeof body.attributionEventId === "number" && Number.isFinite(body.attributionEventId)) {
    try {
      // Tenant-scope the update in the WHERE clause itself (not via a
      // preceding select-then-check) so a refactor of either branch can't
      // accidentally widen the scope to other tenants' events.
      await db.update(attributionEventsTable)
        .set({ resolvedFunnel: funnelType.name })
        .where(and(
          eq(attributionEventsTable.id, body.attributionEventId),
          eq(attributionEventsTable.tenantId, existingLead.tenantId),
        ));
    } catch (err) {
      console.error("[funnel-override.POST] failed to update event resolvedFunnel:", err);
    }
    // Operator just resolved this event by setting a per-lead funnel
    // override, so flip an `unmatched` event to the new `manual` status
    // (100% confidence, no "Why unmatched?" panel). The guard in the
    // helper preserves auto-matched diamond/golden/silver/bronze rows.
    try {
      // Stamp `funnel_override:lead/<leadId>` on the event so the sheet can
      // show "Resolved by per-lead funnel override" and deep-link to the
      // lead whose override produced the flip (task #584).
      await markEventManuallyMatched(
        existingLead.tenantId,
        body.attributionEventId,
        `funnel_override:lead/${leadId}`,
      );
    } catch (err) {
      console.error("[funnel-override.POST] markEventManuallyMatched failed:", err);
    }
  }

  // Reroute the lead through the assignment pipeline so any per-funnel
  // round-robin / sticky CSR logic re-evaluates with the new funnel.
  try {
    await reRouteLeadsAfterAttributionChange(existingLead.tenantId, [leadId]);
  } catch (err) {
    console.error("[funnel-override.POST] reroute failed:", err);
  }

  const [updated] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  emitLeadUpdated(existingLead.tenantId, updated as unknown as Record<string, unknown>);
  res.json({ lead: updated, funnelOverriddenAt: now.toISOString() });
});

// Task #549: clear a per-lead funnel override and re-derive the lead's
// funnel from its latest attribution event. After clearing, the lead is
// back in scope for future tenant-wide alias retags.
//
// Also redetects the *open* attribution event (when supplied) so the
// drawer's resolved_funnel snaps back to the alias-driven value even if the
// override was made from an older, non-latest event — otherwise the
// previously-overridden event row would keep the manually-set funnel name
// and the open drawer would look stale after Undo.
router.delete("/leads/:leadId/funnel-override", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const attributionEventIdRaw = req.query.attributionEventId ?? (req.body as { attributionEventId?: number } | undefined)?.attributionEventId;
  const attributionEventId = attributionEventIdRaw !== undefined && attributionEventIdRaw !== null
    ? Number(attributionEventIdRaw)
    : null;

  const [existingLead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!existingLead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const role = req.session.userRole;
  if (role !== "super_admin" && role !== "agency_user") {
    if (existingLead.tenantId !== req.session.tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  if (!existingLead.funnelOverriddenAt) {
    res.json({ lead: existingLead, cleared: false });
    return;
  }

  await db.update(leadsTable).set({
    funnelOverriddenAt: null,
    funnelOverriddenByUserId: null,
    updatedAt: new Date(),
  }).where(eq(leadsTable.id, leadId));

  try {
    await reDeriveLeadFunnel(existingLead.tenantId, leadId);
  } catch (err) {
    console.error("[funnel-override.DELETE] reDeriveLeadFunnel failed:", err);
  }
  // Recompute the currently-open event too. reDeriveLeadFunnel only
  // touches the lead's latest event, so an override made from an older
  // event would keep its stale resolved_funnel after Undo without this.
  if (attributionEventId !== null && Number.isFinite(attributionEventId) && attributionEventId > 0) {
    try {
      // Verify tenant scope before redetecting — redetectAndPersistEvent
      // already filters by tenantId, but a defensive guard avoids issuing
      // the work at all for cross-tenant ids.
      const [ev] = await db.select({ tenantId: attributionEventsTable.tenantId })
        .from(attributionEventsTable).where(eq(attributionEventsTable.id, attributionEventId)).limit(1);
      if (ev && ev.tenantId === existingLead.tenantId) {
        await redetectAndPersistEvent(existingLead.tenantId, attributionEventId);
      }
    } catch (err) {
      console.error("[funnel-override.DELETE] redetectAndPersistEvent failed:", err);
    }
  }
  try {
    await reRouteLeadsAfterAttributionChange(existingLead.tenantId, [leadId]);
  } catch (err) {
    console.error("[funnel-override.DELETE] reroute failed:", err);
  }

  const [updated] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  emitLeadUpdated(existingLead.tenantId, updated as unknown as Record<string, unknown>);
  res.json({ lead: updated, cleared: true });
});

router.post("/leads/:leadId/call", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const role = req.session.userRole;
  if (role !== "super_admin" && role !== "agency_user") {
    if (lead.tenantId !== req.session.tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  try {
    const result = await initiateCall(
      lead.tenantId,
      leadId,
      userId,
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to initiate call";
    res.status(500).json({ success: false, platform: "unknown", message });
  }
});

router.post("/leads/:leadId/text", async (req, res) => {
  const { leadId } = GetLeadParams.parse({ leadId: req.params.leadId });
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const { message: messageBody } = req.body || {};
  if (!messageBody || typeof messageBody !== "string") {
    res.status(400).json({ error: "Message body is required" });
    return;
  }

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const role = req.session.userRole;
  if (role !== "super_admin" && role !== "agency_user") {
    if (lead.tenantId !== req.session.tenantId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  try {
    const result = await initiateText(
      lead.tenantId,
      leadId,
      userId,
      messageBody,
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send text";
    res.status(500).json({ success: false, platform: "unknown", message });
  }
});

export default router;
