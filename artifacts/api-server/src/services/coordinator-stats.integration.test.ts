/**
 * Real-Postgres integration test for the speed-to-lead query and nightly
 * aggregation in coordinator-stats.
 *
 * The unit suite in coordinator-stats.test.ts covers the pure averaging
 * helper (`computeAvgSpeedFromEvents`) and documents the contract of
 * `newLeadsHandled`. This file exercises the actual DISTINCT-ON SQL against
 * a live Postgres database so the cross-day fix can't silently regress when
 * the query is refactored.
 *
 * Scenarios seeded (all under a fresh tenant so this test never collides
 * with parallel runs or shared dev data):
 *   L1 — assigned on day1, multiple same-day calls by one CSR.
 *   L2 — assigned on day1, first touched on day1, follow-up touch on day2.
 *   L3 — auto-passed mid-day1: pre-pass call by old CSR (before assignedAt,
 *        must be filtered out), response by new CSR after the pass.
 *   L4 — assigned on day1, never called.
 *   L5 — assigned on day2 (today), called same-day on day2.
 *
 * Assertions cover:
 *   - getFirstResponseEvents produces exactly one event per assignment window
 *     and never bumps newLeadsHandled on later days from follow-up touches.
 *   - aggregateDailyStats(dayStr) persists numbers identical to the live
 *     getComparisonStats path for the same day.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql, eq, and, inArray } from "drizzle-orm";

const dbModule = await import("@workspace/db");
const {
  db,
  tenantsTable,
  usersTable,
  leadsTable,
  callAttemptsTable,
  leadAssignmentsTable,
  coordinatorDailyStatsTable,
  userLoginSessionsTable,
} = dbModule;
const {
  getFirstResponseEvents,
  computeAvgSpeedFromEvents,
  aggregateDailyStats,
  getComparisonStats,
} = await import("./coordinator-stats");

async function resyncSerial(table: string, idCol = "id"): Promise<void> {
  await db.execute(sql.raw(
    `SELECT setval(pg_get_serial_sequence('${table}','${idCol}'), COALESCE((SELECT MAX(${idCol}) FROM ${table}), 0) + 1, false)`,
  ));
}

interface Fixtures {
  tenantId: number;
  csr1: number;
  csr2: number;
  leadIds: { L1: number; L2: number; L3: number; L4: number; L5: number };
  day1: Date;
  day2: Date;
  day1Str: string;
  day2Str: string;
  day1Start: Date;
  day1End: Date;
  day2Start: Date;
  day2End: Date;
}

let fx: Fixtures;

function startOfLocalDay(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}
function endOfLocalDay(d: Date): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}
function dateStr(d: Date): string {
  // Local-day formatting (YYYY-MM-DD) matching the aggregator's `${dateStr}T00:00:00` parse.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  await resyncSerial("tenants");
  await resyncSerial("users");
  await resyncSerial("leads");
  await resyncSerial("call_attempts");

  const slug = `stl-int-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [tenant] = await db.insert(tenantsTable).values({
    name: `Speed-to-Lead Int ${slug}`,
    clientSlug: slug,
  }).returning();

  const [u1] = await db.insert(usersTable).values({
    email: `${slug}-csr1@example.com`,
    name: "CSR One",
    passwordHash: "x",
    role: "client_user",
    tenantId: tenant.id,
  }).returning();
  const [u2] = await db.insert(usersTable).values({
    email: `${slug}-csr2@example.com`,
    name: "CSR Two",
    passwordHash: "x",
    role: "client_user",
    tenantId: tenant.id,
  }).returning();

  // day2 = today (so getComparisonStats's NOW-based "today" path lines up with
  // aggregateDailyStats(day2Str)). day1 = yesterday.
  const now = new Date();
  const day2 = startOfLocalDay(now);
  const day1 = new Date(day2);
  day1.setDate(day1.getDate() - 1);

  const day1At = (h: number, m = 0) => {
    const d = new Date(day1); d.setHours(h, m, 0, 0); return d;
  };
  const day2At = (h: number, m = 0) => {
    const d = new Date(day2); d.setHours(h, m, 0, 0); return d;
  };

  // ── Seed leads ──────────────────────────────────────────────────────────
  // L1 — assigned day1 09:00 to CSR1, three same-day calls.
  const [l1] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Lead", lastName: "One",
    source: "Meta", originalSource: "Meta",
    assignedCsrId: u1.id, assignedAt: day1At(9, 0),
  }).returning();
  // L2 — assigned day1 09:00 to CSR1, first touch day1, follow-up touch day2.
  const [l2] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Lead", lastName: "Two",
    source: "Meta", originalSource: "Meta",
    assignedCsrId: u1.id, assignedAt: day1At(9, 0),
  }).returning();
  // L3 — auto-passed mid-day1: current assignment is to CSR2 at 13:00.
  const [l3] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Lead", lastName: "Three",
    source: "Meta", originalSource: "Meta",
    assignedCsrId: u2.id, assignedAt: day1At(13, 0),
  }).returning();
  // L4 — assigned day1 but never called.
  const [l4] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Lead", lastName: "Four",
    source: "Meta", originalSource: "Meta",
    assignedCsrId: u1.id, assignedAt: day1At(9, 0),
  }).returning();
  // L5 — assigned + touched on day2; gives a non-zero "today" signal for the
  // live-vs-aggregation parity check.
  const [l5] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Lead", lastName: "Five",
    source: "Meta", originalSource: "Meta",
    assignedCsrId: u1.id, assignedAt: day2At(9, 0),
  }).returning();

  // ── Seed call attempts ─────────────────────────────────────────────────
  await db.insert(callAttemptsTable).values([
    // L1: same-day repeat — first touch at 09:02 (120s wall-clock).
    { leadId: l1.id, userId: u1.id, outcome: "no_answer", actionType: "call", attemptedAt: day1At(9, 2) },
    { leadId: l1.id, userId: u1.id, outcome: "no_answer", actionType: "call", attemptedAt: day1At(9, 30) },
    { leadId: l1.id, userId: u1.id, outcome: "spoke_with_customer", actionType: "call", attemptedAt: day1At(10, 0) },

    // L2: first touch day1 09:03 (180s wall-clock), cross-day follow-up next day.
    { leadId: l2.id, userId: u1.id, outcome: "no_answer", actionType: "call", attemptedAt: day1At(9, 3) },
    { leadId: l2.id, userId: u1.id, outcome: "no_answer", actionType: "call", attemptedAt: day2At(10, 0) },

    // L3: pre-pass call by CSR1 at 09:30 (BEFORE the 13:00 reassignment — must
    // be filtered by `attemptedAt >= leadsTable.assignedAt`). Post-pass response
    // by CSR2 at 13:05 (300s wall-clock relative to 13:00 assignment).
    { leadId: l3.id, userId: u1.id, outcome: "no_answer", actionType: "call", attemptedAt: day1At(9, 30) },
    { leadId: l3.id, userId: u2.id, outcome: "spoke_with_customer", actionType: "call", attemptedAt: day1At(13, 5) },

    // L5: same-day-only on day2, 60s wall-clock.
    { leadId: l5.id, userId: u1.id, outcome: "spoke_with_customer", actionType: "call", attemptedAt: day2At(9, 1) },
  ]);

  // Login sessions spanning both days so the login-aware speed equals
  // wall-clock (no idle gaps to subtract). Keeps assertions deterministic.
  const sessionStart = new Date(day1); sessionStart.setHours(0, 0, 0, 0);
  const sessionEnd = new Date(day2); sessionEnd.setHours(23, 59, 59, 999);
  await db.insert(userLoginSessionsTable).values([
    { userId: u1.id, tenantId: tenant.id, loginAt: sessionStart, logoutAt: sessionEnd },
    { userId: u2.id, tenantId: tenant.id, loginAt: sessionStart, logoutAt: sessionEnd },
  ]);

  fx = {
    tenantId: tenant.id,
    csr1: u1.id,
    csr2: u2.id,
    leadIds: { L1: l1.id, L2: l2.id, L3: l3.id, L4: l4.id, L5: l5.id },
    day1, day2,
    day1Str: dateStr(day1), day2Str: dateStr(day2),
    day1Start: startOfLocalDay(day1), day1End: endOfLocalDay(day1),
    day2Start: startOfLocalDay(day2), day2End: endOfLocalDay(day2),
  };
});

afterAll(async () => {
  if (!fx) return;
  const allLeadIds = Object.values(fx.leadIds);
  try {
    await db.delete(callAttemptsTable).where(inArray(callAttemptsTable.leadId, allLeadIds));
    await db.delete(leadsTable).where(inArray(leadsTable.id, allLeadIds));
    await db.delete(coordinatorDailyStatsTable).where(eq(coordinatorDailyStatsTable.tenantId, fx.tenantId));
    await db.delete(userLoginSessionsTable).where(inArray(userLoginSessionsTable.userId, [fx.csr1, fx.csr2]));
    await db.delete(usersTable).where(inArray(usersTable.id, [fx.csr1, fx.csr2]));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("getFirstResponseEvents (real Postgres)", () => {
  it("returns exactly one event per (lead, assignedAt) for day1 across the seeded tenant", async () => {
    const events = await getFirstResponseEvents([fx.csr1, fx.csr2], fx.day1Start, fx.day1End);

    // Restrict to our tenant's leads (the DB may contain unrelated rows).
    const ours = events.filter(e => Object.values(fx.leadIds).includes(e.leadId));

    // Expect L1 (CSR1), L2 (CSR1), L3 (CSR2). No L4 (never called).
    // L3's pre-pass attempt at 09:30 by CSR1 is BEFORE the 13:00 reassignment
    // and must not produce an event for CSR1.
    expect(ours.map(e => e.leadId).sort()).toEqual([fx.leadIds.L1, fx.leadIds.L2, fx.leadIds.L3].sort());

    const byLead = Object.fromEntries(ours.map(e => [e.leadId, e]));
    expect(byLead[fx.leadIds.L1].userId).toBe(fx.csr1);
    expect(byLead[fx.leadIds.L1].wallClockSpeed).toBeCloseTo(120, 0);

    expect(byLead[fx.leadIds.L2].userId).toBe(fx.csr1);
    expect(byLead[fx.leadIds.L2].wallClockSpeed).toBeCloseTo(180, 0);
    // First touch is the day1 09:03 attempt — NOT the day2 follow-up.
    expect(byLead[fx.leadIds.L2].firstTouchAt.getTime()).toBeLessThan(fx.day2Start.getTime());

    expect(byLead[fx.leadIds.L3].userId).toBe(fx.csr2);
    expect(byLead[fx.leadIds.L3].wallClockSpeed).toBeCloseTo(300, 0);
  });

  it("does not produce a new event on day2 for a cross-day follow-up touch (L2)", async () => {
    const events = await getFirstResponseEvents([fx.csr1, fx.csr2], fx.day2Start, fx.day2End);
    const ours = events.filter(e => Object.values(fx.leadIds).includes(e.leadId));

    // Only L5 should appear on day2. L2's day2 follow-up must NOT create a
    // second event — its first-response event lives on day1.
    expect(ours.map(e => e.leadId)).toEqual([fx.leadIds.L5]);
    expect(ours[0].userId).toBe(fx.csr1);
    expect(ours[0].wallClockSpeed).toBeCloseTo(60, 0);
  });

  it("scopes by userIds: requesting only CSR2 on day1 returns just L3", async () => {
    const events = await getFirstResponseEvents([fx.csr2], fx.day1Start, fx.day1End);
    const ours = events.filter(e => Object.values(fx.leadIds).includes(e.leadId));
    expect(ours.map(e => e.leadId)).toEqual([fx.leadIds.L3]);
  });
});

describe("aggregateDailyStats parity with live getComparisonStats (real Postgres)", () => {
  it("nightly aggregation for 'today' equals the live today snapshot for the same CSR", async () => {
    // Live snapshot first — uses NOW()-based "today" window inside the service.
    const live = await getComparisonStats(fx.tenantId, fx.csr1, "yesterday");

    // Then aggregate the same day (today) and read the persisted row.
    const processed = await aggregateDailyStats(fx.day2Str);
    expect(processed).toBeGreaterThanOrEqual(1);

    const [aggRow] = await db.select().from(coordinatorDailyStatsTable).where(and(
      eq(coordinatorDailyStatsTable.userId, fx.csr1),
      eq(coordinatorDailyStatsTable.date, fx.day2Str),
    ));
    expect(aggRow).toBeDefined();

    // Live "today" stats and the persisted aggregation must agree.
    expect(aggRow.callsMade).toBe(live.today.callsMade);
    expect(aggRow.bookingsCount).toBe(live.today.bookingsCount);
    expect(Math.round(aggRow.avgSpeedToLead)).toBe(Math.round(live.today.avgSpeedToLead));

    // L5 contributes one event (60s); L2's day2 follow-up does NOT add an event
    // or inflate the average.
    expect(aggRow.newLeadsHandled).toBe(1);
    expect(aggRow.avgSpeedToLead).toBeCloseTo(60, 0);

    // CSR1 made two call attempts on day2 (L5 + L2 follow-up). callsMade is
    // raw attempts, not first-response events.
    expect(aggRow.callsMade).toBe(2);
  });

  it("aggregating day1 records the correct per-CSR numbers from first-response events only", async () => {
    const processed = await aggregateDailyStats(fx.day1Str);
    expect(processed).toBeGreaterThanOrEqual(2);

    const rows = await db.select().from(coordinatorDailyStatsTable).where(and(
      eq(coordinatorDailyStatsTable.tenantId, fx.tenantId),
      eq(coordinatorDailyStatsTable.date, fx.day1Str),
    ));
    const byUser = Object.fromEntries(rows.map(r => [r.userId, r]));

    // CSR1: events for L1 (120s) and L2 (180s) → avg 150, newLeads = 2.
    expect(byUser[fx.csr1]).toBeDefined();
    expect(byUser[fx.csr1].newLeadsHandled).toBe(2);
    expect(byUser[fx.csr1].avgSpeedToLead).toBeCloseTo(150, 0);

    // CSR2: event for L3 only (300s) → avg 300, newLeads = 1. The pre-pass
    // attempt CSR1 made at 09:30 does NOT count toward CSR1 because it was
    // before L3's current assignedAt.
    expect(byUser[fx.csr2]).toBeDefined();
    expect(byUser[fx.csr2].newLeadsHandled).toBe(1);
    expect(byUser[fx.csr2].avgSpeedToLead).toBeCloseTo(300, 0);
  });

  it("re-aggregating day1 a second time is idempotent (ON CONFLICT DO UPDATE)", async () => {
    await aggregateDailyStats(fx.day1Str);
    const rows = await db.select().from(coordinatorDailyStatsTable).where(and(
      eq(coordinatorDailyStatsTable.tenantId, fx.tenantId),
      eq(coordinatorDailyStatsTable.date, fx.day1Str),
    ));
    const byUser = Object.fromEntries(rows.map(r => [r.userId, r]));
    expect(byUser[fx.csr1].newLeadsHandled).toBe(2);
    expect(byUser[fx.csr2].newLeadsHandled).toBe(1);
  });

  it("computeAvgSpeedFromEvents over day1 events matches the persisted avg for the tenant", async () => {
    const events = await getFirstResponseEvents([fx.csr1, fx.csr2], fx.day1Start, fx.day1End);
    const ours = events.filter(e => Object.values(fx.leadIds).includes(e.leadId));
    const computed = await computeAvgSpeedFromEvents(ours);
    // (120 + 180 + 300) / 3 = 200
    expect(Math.round(computed)).toBe(200);
  });
});

/**
 * Task #407 — Reassignment history. When a lead is reassigned mid-day, the
 * prior assignment window must still produce its own first-response event:
 * the new assignment cannot overwrite or destroy the old one. The trigger on
 * `leads` writes a new `lead_assignments` row (and closes the prior active
 * row) whenever `assigned_csr_id` or `assigned_at` changes.
 */
describe("lead_assignments history makes speed-to-lead reproducible (task #407)", () => {
  interface ReassignFx {
    tenantId: number;
    csr1: number;
    csr2: number;
    leadId: number;
    day1Start: Date;
    day1End: Date;
  }
  let rfx: ReassignFx;

  beforeAll(async () => {
    const slug = `stl-reassign-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const [tenant] = await db.insert(tenantsTable).values({
      name: `Speed-to-Lead Reassign ${slug}`,
      clientSlug: slug,
    }).returning();
    const [u1] = await db.insert(usersTable).values({
      email: `${slug}-csr1@example.com`, name: "RCSR One", passwordHash: "x",
      role: "client_user", tenantId: tenant.id,
    }).returning();
    const [u2] = await db.insert(usersTable).values({
      email: `${slug}-csr2@example.com`, name: "RCSR Two", passwordHash: "x",
      role: "client_user", tenantId: tenant.id,
    }).returning();

    const day1 = new Date(); day1.setDate(day1.getDate() - 1); day1.setHours(0, 0, 0, 0);
    const at = (h: number, m = 0) => {
      const d = new Date(day1); d.setHours(h, m, 0, 0); return d;
    };

    // Insert lead initially assigned to CSR1 at 09:00 — trigger writes row #1.
    const [lead] = await db.insert(leadsTable).values({
      tenantId: tenant.id, firstName: "Reassign", lastName: "Me",
      source: "Meta", originalSource: "Meta",
      assignedCsrId: u1.id, assignedAt: at(9, 0),
    }).returning();

    // Reassign to CSR2 at 13:00 — trigger closes row #1 (ended_at=13:00) and
    // inserts row #2 (assigned_at=13:00, csr=u2, ended_at=NULL).
    await db.update(leadsTable)
      .set({ assignedCsrId: u2.id, assignedAt: at(13, 0), updatedAt: new Date() })
      .where(eq(leadsTable.id, lead.id));

    // Calls in each window.
    await db.insert(callAttemptsTable).values([
      // Window A (09:00–13:00): CSR1 first touch at 09:30 → 1800s.
      { leadId: lead.id, userId: u1.id, outcome: "no_answer", actionType: "call", attemptedAt: at(9, 30) },
      // Window B (13:00–∞): CSR2 first touch at 13:05 → 300s.
      { leadId: lead.id, userId: u2.id, outcome: "spoke_with_customer", actionType: "call", attemptedAt: at(13, 5) },
    ]);

    rfx = {
      tenantId: tenant.id, csr1: u1.id, csr2: u2.id, leadId: lead.id,
      day1Start: startOfLocalDay(day1), day1End: endOfLocalDay(day1),
    };
  });

  afterAll(async () => {
    if (!rfx) return;
    try {
      await db.delete(callAttemptsTable).where(eq(callAttemptsTable.leadId, rfx.leadId));
      await db.delete(leadsTable).where(eq(leadsTable.id, rfx.leadId));
      await db.delete(usersTable).where(inArray(usersTable.id, [rfx.csr1, rfx.csr2]));
      await db.delete(tenantsTable).where(eq(tenantsTable.id, rfx.tenantId));
    } catch { /* best-effort */ }
  });

  it("trigger writes one row per assignment window (initial + change)", async () => {
    const rows = await db.select().from(leadAssignmentsTable)
      .where(eq(leadAssignmentsTable.leadId, rfx.leadId))
      .orderBy(leadAssignmentsTable.assignedAt);
    expect(rows.length).toBe(2);

    // Row 1: initial assignment to CSR1, closed when the change happened.
    expect(rows[0].assignedCsrId).toBe(rfx.csr1);
    expect(rows[0].endedAt).not.toBeNull();
    expect(rows[0].reason).toBe("initial");

    // Row 2: current assignment to CSR2, still active.
    expect(rows[1].assignedCsrId).toBe(rfx.csr2);
    expect(rows[1].endedAt).toBeNull();
    expect(rows[1].reason).toBe("change");

    // The first window's ended_at must equal the second window's assigned_at.
    expect(rows[0].endedAt!.getTime()).toBe(rows[1].assignedAt.getTime());
  });

  it("produces a distinct first-response event for each assignment window", async () => {
    const events = await getFirstResponseEvents(
      [rfx.csr1, rfx.csr2], rfx.day1Start, rfx.day1End,
    );
    const ours = events.filter(e => e.leadId === rfx.leadId);

    // TWO events for the same lead on day1 — one per window.
    expect(ours).toHaveLength(2);

    const byUser = Object.fromEntries(ours.map(e => [e.userId, e]));
    expect(byUser[rfx.csr1]).toBeDefined();
    expect(byUser[rfx.csr1].wallClockSpeed).toBeCloseTo(1800, 0); // 09:00 → 09:30
    expect(byUser[rfx.csr2]).toBeDefined();
    expect(byUser[rfx.csr2].wallClockSpeed).toBeCloseTo(300, 0);  // 13:00 → 13:05
  });

  it("requesting only the original CSR still returns the historical window after reassignment", async () => {
    const events = await getFirstResponseEvents([rfx.csr1], rfx.day1Start, rfx.day1End);
    const ours = events.filter(e => e.leadId === rfx.leadId);
    // Even though leads.assignedCsrId is now CSR2, the durable history keeps
    // the prior window discoverable for CSR1.
    expect(ours).toHaveLength(1);
    expect(ours[0].userId).toBe(rfx.csr1);
    expect(ours[0].wallClockSpeed).toBeCloseTo(1800, 0);
  });
});
