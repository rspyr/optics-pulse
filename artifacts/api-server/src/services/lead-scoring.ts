import { db, callAttemptsTable, leadsTable, scheduledFollowupsTable } from "@workspace/db";
import { eq, and, desc, sql, inArray, gte, lte } from "drizzle-orm";

interface CallAttemptRecord {
  id: number;
  leadId: number;
  userId: number;
  method: string;
  outcome: string;
  platform: string;
  attemptedAt: Date;
  notes: string | null;
}

export interface LeadSuggestion {
  bestTimeWindow: string | null;
  reason: string;
  doubleDial: boolean;
  inOptimalWindow: boolean;
  priorityScore: number;
  priorityReason: string;
  confidenceScore: number;
  totalAttempts: number;
  lastAttemptAt: string | null;
  failedAttempts: number;
}

interface HourBucket {
  total: number;
  answered: number;
  voicemail: number;
  noAnswer: number;
}

function getHourBuckets(attempts: CallAttemptRecord[]): Map<number, HourBucket> {
  const buckets = new Map<number, HourBucket>();
  for (const a of attempts) {
    const hour = new Date(a.attemptedAt).getHours();
    const b = buckets.get(hour) || { total: 0, answered: 0, voicemail: 0, noAnswer: 0 };
    b.total++;
    if (a.outcome === "answered") b.answered++;
    else if (a.outcome === "voicemail") b.voicemail++;
    else if (a.outcome === "no_answer" || a.outcome === "busy") b.noAnswer++;
    buckets.set(hour, b);
  }
  return buckets;
}


function formatHourRange(start: number): string {
  const end = Math.min(start + 2, 23);
  const fmt = (h: number) => {
    const ampm = h >= 12 ? "pm" : "am";
    const hr = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${hr}${ampm}`;
  };
  return `${fmt(start)}-${fmt(end)}`;
}

function getFailedHoursSummary(attempts: CallAttemptRecord[]): string {
  const failedHours = new Set<number>();
  for (const a of attempts) {
    if (a.outcome === "voicemail" || a.outcome === "no_answer" || a.outcome === "busy") {
      failedHours.add(new Date(a.attemptedAt).getHours());
    }
  }
  if (failedHours.size === 0) return "";
  const sorted = [...failedHours].sort((a, b) => a - b);
  const fmt = (h: number) => {
    const ampm = h >= 12 ? "pm" : "am";
    const hr = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${hr}${ampm}`;
  };
  return sorted.map(fmt).join(", ");
}

export function analyzeContactPattern(attempts: CallAttemptRecord[]): LeadSuggestion {
  const now = new Date();
  const currentHour = now.getHours();
  const currentDay = now.getDay();

  if (attempts.length === 0) {
    return {
      bestTimeWindow: null,
      reason: "New lead — call immediately for best booking chance",
      doubleDial: false,
      inOptimalWindow: true,
      priorityScore: 100,
      priorityReason: "Brand new lead",
      confidenceScore: 50,
      totalAttempts: 0,
      lastAttemptAt: null,
      failedAttempts: 0,
    };
  }

  const hourBuckets = getHourBuckets(attempts);
  const failedAttempts = attempts.filter(a =>
    a.outcome === "voicemail" || a.outcome === "no_answer" || a.outcome === "busy"
  ).length;
  const answeredAttempts = attempts.filter(a => a.outcome === "answered").length;
  const lastAttempt = attempts[0];
  const lastAttemptTime = new Date(lastAttempt.attemptedAt);
  const hoursSinceLastAttempt = (now.getTime() - lastAttemptTime.getTime()) / (1000 * 60 * 60);
  const lastHour = lastAttemptTime.getHours();
  const isMorning = lastHour < 12;
  const failedHoursSummary = getFailedHoursSummary(attempts);

  const triedHours = [...hourBuckets.keys()].sort((a, b) => a - b);
  const allFailed = failedAttempts === attempts.length && answeredAttempts === 0;
  const weekdayOnly = attempts.every(a => {
    const d = new Date(a.attemptedAt).getDay();
    return d >= 1 && d <= 5;
  });
  const businessHoursOnly = attempts.every(a => {
    const h = new Date(a.attemptedAt).getHours();
    return h >= 8 && h <= 17;
  });

  let bestTimeWindow: string | null = null;
  let reason = "";
  let doubleDial = false;
  let inOptimalWindow = false;

  if (answeredAttempts > 0) {
    const answeredHours = attempts
      .filter(a => a.outcome === "answered")
      .map(a => new Date(a.attemptedAt).getHours());
    const avgAnsweredHour = Math.round(answeredHours.reduce((a, b) => a + b, 0) / answeredHours.length);
    bestTimeWindow = formatHourRange(Math.max(avgAnsweredHour - 1, 8));
    reason = `Previously answered around ${formatHourRange(avgAnsweredHour)} — call during this window`;
    inOptimalWindow = Math.abs(currentHour - avgAnsweredHour) <= 1;
  } else if (allFailed && failedAttempts >= 3 && businessHoursOnly && weekdayOnly) {
    bestTimeWindow = "Saturday 10am-12pm or weekday 5-7pm";
    reason = `No answer at ${failedHoursSummary} during weekday business hours — try Saturday morning or weekday evening`;
    inOptimalWindow = (currentDay === 6 && currentHour >= 10 && currentHour <= 12) ||
      (currentDay >= 1 && currentDay <= 5 && currentHour >= 17 && currentHour <= 19);
  } else if (allFailed && failedAttempts >= 2) {
    const triedMorning = triedHours.some(h => h < 12);
    const triedAfternoon = triedHours.some(h => h >= 12);
    if (triedMorning && !triedAfternoon) {
      bestTimeWindow = formatHourRange(14);
      reason = `Voicemail at ${failedHoursSummary} — try afternoon instead`;
      inOptimalWindow = currentHour >= 14 && currentHour <= 17;
    } else if (!triedMorning && triedAfternoon) {
      bestTimeWindow = formatHourRange(9);
      reason = `Voicemail at ${failedHoursSummary} — try morning instead`;
      inOptimalWindow = currentHour >= 9 && currentHour <= 11;
    } else {
      if (weekdayOnly) {
        bestTimeWindow = "Saturday 10am-12pm";
        reason = `Tried morning and afternoon on weekdays with no answer — try Saturday`;
        inOptimalWindow = currentDay === 6 && currentHour >= 10 && currentHour <= 12;
      } else {
        bestTimeWindow = "Weekday 6-7pm";
        reason = `Multiple failed attempts — try early evening`;
        inOptimalWindow = currentHour >= 17 && currentHour <= 19;
      }
    }
  } else if (lastAttempt.outcome === "voicemail" || lastAttempt.outcome === "no_answer") {
    doubleDial = true;
    if (isMorning) {
      const suggestedHour = Math.min(lastHour + 5, 17);
      bestTimeWindow = formatHourRange(suggestedHour);
      reason = `Voicemail at ${formatHourRange(lastHour)} — double-dial this afternoon around ${formatHourRange(suggestedHour)}`;
      inOptimalWindow = currentHour >= suggestedHour && currentHour <= suggestedHour + 2;
    } else {
      bestTimeWindow = formatHourRange(9);
      reason = `Voicemail at ${formatHourRange(lastHour)} — try tomorrow morning 9-11am`;
      inOptimalWindow = currentHour >= 9 && currentHour <= 11 && hoursSinceLastAttempt >= 12;
    }
  } else {
    bestTimeWindow = formatHourRange(lastHour);
    reason = `Previous contact at ${formatHourRange(lastHour)} — follow up during similar window`;
    inOptimalWindow = Math.abs(currentHour - lastHour) <= 1;
  }

  let priorityScore = 50;
  let priorityReason = "";

  if (lastAttempt.outcome === "answered" && hoursSinceLastAttempt < 24) {
    priorityScore = 30;
    priorityReason = "Recently reached — follow up during same window";
  } else if (inOptimalWindow) {
    priorityScore = 85 - (failedAttempts * 3);
    priorityReason = "In optimal contact window now";
  } else if (hoursSinceLastAttempt >= 24 && hoursSinceLastAttempt < 48) {
    priorityScore = 65;
    priorityReason = "Due for re-contact (24+ hours)";
  } else if (hoursSinceLastAttempt >= 48) {
    priorityScore = 55 - Math.min(failedAttempts * 5, 25);
    priorityReason = "Stale lead — contact timing matters more";
  } else if (hoursSinceLastAttempt < 2) {
    priorityScore = 15;
    priorityReason = "Recently attempted — wait before retrying";
  } else {
    priorityScore = 45;
    priorityReason = "Standard follow-up priority";
  }

  if (failedAttempts >= 5) {
    priorityScore = Math.max(priorityScore - 20, 5);
    priorityReason = "Many failed attempts — timing critical";
  }

  let confidenceScore = 50;
  if (attempts.length >= 5) confidenceScore = 85;
  else if (attempts.length >= 3) confidenceScore = 75;
  else if (attempts.length >= 2) confidenceScore = 65;
  else if (attempts.length === 1) confidenceScore = 55;
  if (answeredAttempts > 0) confidenceScore = Math.min(confidenceScore + 10, 95);

  return {
    bestTimeWindow,
    reason,
    doubleDial,
    inOptimalWindow,
    priorityScore: Math.max(Math.min(priorityScore, 100), 0),
    priorityReason,
    confidenceScore,
    totalAttempts: attempts.length,
    lastAttemptAt: lastAttempt.attemptedAt.toISOString(),
    failedAttempts,
  };
}

export interface ScoredLead {
  lead: Record<string, unknown>;
  suggestion: LeadSuggestion;
  bucket: "new" | "followup" | "background";
}

export async function getSmartQueue(tenantId: number | null): Promise<{
  leads: ScoredLead[];
  newCount: number;
  followUpCount: number;
  backgroundCount: number;
  total: number;
}> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (tenantId) conditions.push(eq(leadsTable.tenantId, tenantId));

  const statusCondition = inArray(leadsTable.status, ["new", "contacted"]);
  const where = conditions.length > 0 ? and(...conditions, statusCondition) : statusCondition;

  const leads = await db.select().from(leadsTable).where(where).orderBy(desc(leadsTable.createdAt)).limit(100);

  if (leads.length === 0) {
    return { leads: [], newCount: 0, followUpCount: 0, backgroundCount: 0, total: 0 };
  }

  const leadIds = leads.map(l => l.id);
  const allAttempts = await db.select().from(callAttemptsTable)
    .where(inArray(callAttemptsTable.leadId, leadIds))
    .orderBy(desc(callAttemptsTable.attemptedAt));

  const attemptsByLead = new Map<number, CallAttemptRecord[]>();
  for (const a of allAttempts) {
    const list = attemptsByLead.get(a.leadId) || [];
    list.push(a);
    attemptsByLead.set(a.leadId, list);
  }

  let tenantHourlyRates: Map<number, number> | null = null;
  if (tenantId) {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const tenantAttempts = await db.select({
        hour: sql<number>`EXTRACT(HOUR FROM ${callAttemptsTable.attemptedAt})::int`,
        outcome: callAttemptsTable.outcome,
      }).from(callAttemptsTable)
        .innerJoin(leadsTable, eq(callAttemptsTable.leadId, leadsTable.id))
        .where(and(
          eq(leadsTable.tenantId, tenantId),
          gte(callAttemptsTable.attemptedAt, thirtyDaysAgo)
        ));

      if (tenantAttempts.length >= 10) {
        const hourStats = new Map<number, { total: number; answered: number }>();
        for (const row of tenantAttempts) {
          const s = hourStats.get(row.hour) || { total: 0, answered: 0 };
          s.total++;
          if (row.outcome === "answered") s.answered++;
          hourStats.set(row.hour, s);
        }
        tenantHourlyRates = new Map();
        for (const [hour, stats] of hourStats) {
          tenantHourlyRates.set(hour, stats.total > 0 ? stats.answered / stats.total : 0);
        }
      }
    } catch {}
  }

  const nowDate = new Date();
  const pendingFollowups = await db.select().from(scheduledFollowupsTable)
    .where(and(
      inArray(scheduledFollowupsTable.leadId, leadIds),
      eq(scheduledFollowupsTable.completed, false),
      lte(scheduledFollowupsTable.scheduledFor, nowDate),
    ));

  const followupsByLead = new Map<number, typeof pendingFollowups>();
  for (const f of pendingFollowups) {
    const list = followupsByLead.get(f.leadId) || [];
    list.push(f);
    followupsByLead.set(f.leadId, list);
  }

  const now = Date.now();
  const currentHour = nowDate.getHours();

  const scoredLeads: ScoredLead[] = leads.map(lead => {
    const attempts = attemptsByLead.get(lead.id) || [];
    const suggestion = analyzeContactPattern(attempts);
    const isNew = lead.status === "new";

    if (isNew) {
      const ageMs = now - new Date(lead.createdAt).getTime();
      const ageMinutes = ageMs / (1000 * 60);
      suggestion.priorityScore = Math.max(100 - Math.floor(ageMinutes / 5), 70);
      suggestion.priorityReason = ageMinutes < 5
        ? "Brand new lead — call within 60 seconds!"
        : ageMinutes < 30
          ? "New lead — call ASAP for best booking chance"
          : "New lead aging — prioritize immediately";
      suggestion.inOptimalWindow = true;

      if (attempts.length === 0 && tenantHourlyRates) {
        const rate = tenantHourlyRates.get(currentHour);
        if (rate !== undefined && rate > 0.3) {
          suggestion.reason = `Good pickup rate at this hour (${Math.round(rate * 100)}%) — call now`;
        } else if (rate !== undefined && rate < 0.1) {
          const bestHour = [...tenantHourlyRates.entries()]
            .sort(([, a], [, b]) => b - a)[0];
          if (bestHour) {
            suggestion.reason = `Leads answer best around ${formatHourRange(bestHour[0])} (${Math.round(bestHour[1] * 100)}% rate) — but call now anyway since it's new`;
          }
        }
      }
    }

    const leadFollowups = followupsByLead.get(lead.id) || [];
    if (leadFollowups.length > 0) {
      const boost = Math.min(leadFollowups.length * 10, 20);
      suggestion.priorityScore = Math.min(suggestion.priorityScore + boost, 100);
      suggestion.priorityReason = `Scheduled follow-up due now — ${suggestion.priorityReason}`;
      suggestion.doubleDial = true;
    }

    const updatedAt = new Date(lead.updatedAt).getTime();
    const ageSinceUpdate = now - updatedAt;
    const is24HPlus = ageSinceUpdate >= 24 * 60 * 60 * 1000;

    let bucket: "new" | "followup" | "background";
    if (isNew) {
      bucket = "new";
    } else if (leadFollowups.length > 0 || !is24HPlus) {
      bucket = "followup";
    } else {
      bucket = "background";
    }

    return {
      lead: lead as unknown as Record<string, unknown>,
      suggestion,
      bucket,
    };
  });

  scoredLeads.sort((a, b) => {
    const bucketOrder = { new: 0, followup: 1, background: 2 };
    const bucketDiff = bucketOrder[a.bucket] - bucketOrder[b.bucket];
    if (bucketDiff !== 0) return bucketDiff;

    if (a.suggestion.inOptimalWindow && !b.suggestion.inOptimalWindow) return -1;
    if (!a.suggestion.inOptimalWindow && b.suggestion.inOptimalWindow) return 1;

    return b.suggestion.priorityScore - a.suggestion.priorityScore;
  });

  return {
    leads: scoredLeads,
    newCount: scoredLeads.filter(l => l.bucket === "new").length,
    followUpCount: scoredLeads.filter(l => l.bucket === "followup").length,
    backgroundCount: scoredLeads.filter(l => l.bucket === "background").length,
    total: scoredLeads.length,
  };
}

interface LogAttemptInput {
  leadId: number;
  userId: number;
  method: string;
  outcome: string;
  platform: string;
  notes: string | null;
  attemptedAt?: Date;
  actionType?: string;
}

export async function logAttemptWithFollowup(
  dbInstance: typeof db,
  input: LogAttemptInput,
): Promise<void> {
  await dbInstance.insert(callAttemptsTable).values({
    leadId: input.leadId,
    userId: input.userId,
    method: input.method,
    outcome: input.outcome,
    platform: input.platform,
    attemptedAt: input.attemptedAt || new Date(),
    notes: input.notes,
    actionType: input.actionType || input.method,
  });

  if (input.outcome === "voicemail" || input.outcome === "no_answer" || input.outcome === "busy") {
    const now = input.attemptedAt || new Date();
    const currentHour = now.getHours();
    let scheduledFor: Date;
    let reason: string;

    if (currentHour < 12) {
      scheduledFor = new Date(now);
      scheduledFor.setHours(currentHour + 4, 0, 0, 0);
      reason = `Double-dial: missed ${input.method} this morning — retry this afternoon`;
    } else {
      scheduledFor = new Date(now);
      scheduledFor.setDate(scheduledFor.getDate() + 1);
      scheduledFor.setHours(9, 0, 0, 0);
      reason = `Re-engagement: missed ${input.method} this afternoon — retry tomorrow morning`;
    }

    await dbInstance.insert(scheduledFollowupsTable).values({
      leadId: input.leadId,
      userId: input.userId,
      reason,
      scheduledFor,
    });
  }
}
