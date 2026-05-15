import { Router, type IRouter } from "express";
import { db, leadsTable, callAttemptsTable, podiumMessagesTable, funnelTypesTable, leadMergesTable } from "@workspace/db";
import { eq, and, count, desc, sql, SQL, inArray, gte, lte } from "drizzle-orm";
import { ListLeadsQueryParams, GetLeadParams, UpdateLeadBody } from "@workspace/api-zod";
import { getHudStats, emitLeadUpdated } from "../socket";
import { initiateCall, initiateText, getTenantCommConfig, getCommConfigStatus } from "../services/integrations/communication";
import { getSmartQueue } from "../services/lead-scoring";
import { getComparisonStats, getHistoricalStats, aggregateDailyStats } from "../services/coordinator-stats";
import type { ComparisonBaseline } from "../services/coordinator-stats";
import { parseFilterQuery } from "../services/parse-filter";
import { resolveListTenantScope, assertResourceTenantAccess } from "../lib/tenant-scope";

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

  const scope = resolveListTenantScope(req, res, query.tenantId);
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
    db.select().from(leadsTable).where(where).orderBy(desc(leadsTable.createdAt)).limit(limit).offset(offset),
    db.select({ count: count() }).from(leadsTable).where(where),
  ]);

  res.json({ leads, total: totalResult.count });
});

router.get("/leads/hud/queue", async (req, res) => {
  const queryTenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const scope = resolveListTenantScope(req, res, queryTenantId);
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
  const scope = resolveListTenantScope(req, res, queryTenantId);
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
  const scope = resolveListTenantScope(req, res, queryTenantId);
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
  const scope = resolveListTenantScope(req, res, queryTenantId);
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
  const scope = resolveListTenantScope(req, res, queryTenantId);
  if (!scope.ok) return;
  // Search requires a concrete tenant scope. For super_admin /
  // agency_user with no tenantId param, fall back to their session
  // tenantId (if any) — same behavior as before, just routed through
  // the shared helper for tenant-scoped roles.
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
        fuzzyConditions.push(
          sql`(${leadsTable.phone} IS NOT NULL AND regexp_replace(${leadsTable.phone}, '[^0-9]', '', 'g') LIKE '%' || ${digitsOnly} || '%')`
        );
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
          CASE WHEN ${leadsTable.phone} IS NOT NULL AND regexp_replace(${leadsTable.phone}, '[^0-9]', '', 'g') LIKE '%' || ${digitsOnly} || '%' THEN 0.8 ELSE 0 END,
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
          .orderBy(orderExpr, desc(leadsTable.createdAt))
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
        .orderBy(textQuery ? desc(sql`relevance`) : desc(leadsTable.createdAt), desc(leadsTable.createdAt))
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
  }).from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!existingLead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const access = assertResourceTenantAccess(req, res, existingLead.tenantId);
  if (!access.ok) return;
  const body = UpdateLeadBody.parse(req.body);
  const updateData: Partial<typeof leadsTable.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
  if (body.status) {
    updateData.status = body.status as "new" | "contacted" | "booked" | "sold" | "lost" | "cancelled";
    // Task #413: stamp bookedAt when this PATCH is the path that transitions
    // the lead into booked/sold so daily booking attribution is anchored to
    // the booking moment, not the row's last-touched timestamp.
    if ((body.status === "booked" || body.status === "sold") && !existingLead.bookedAt) {
      updateData.bookedAt = new Date();
    }
  }
  if (body.assignedTo) updateData.assignedTo = body.assignedTo;
  if (body.disposition) updateData.disposition = body.disposition;

  const [lead] = await db.update(leadsTable).set(updateData).where(eq(leadsTable.id, leadId)).returning();
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
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
