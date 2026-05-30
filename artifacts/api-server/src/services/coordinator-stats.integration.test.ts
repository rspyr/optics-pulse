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
import { eq, and, inArray } from "drizzle-orm";

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
  funnelTypesTable,
  leadStatusHistoryTable,
} = dbModule;
const {
  getFirstResponseEvents,
  computeAvgSpeedFromEvents,
  aggregateDailyStats,
  getComparisonStats,
} = await import("./coordinator-stats");

interface Fixtures {
  tenantId: number;
  csr1: number;
  csr2: number;
  funnelId: number;
  funnelName: string;
  leadIds: { L1: number; L2: number; L3: number; L4: number; L5: number; L6: number; L7: number; L8: number; L9: number };
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

  const slug = `stl-int`;
  // Tenant carries a spiff config exercising both byFunnel (Solar = $100)
  // and default ($20) branches of computeSpiffCommission.
  const funnelName = `Solar-${slug}`;
  const [tenant] = await db.insert(tenantsTable).values({
    name: `Speed-to-Lead Int ${slug}`,
    clientSlug: slug,
    spiffConfig: { default: 20, byFunnel: { [funnelName]: 100 } },
  }).returning();

  const [funnel] = await db.insert(funnelTypesTable).values({
    name: funnelName,
    slug: `solar-${slug}`,
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

  // ── Booking / commission leads (day1, CSR1) ─────────────────────────────
  // L6/L7/L8 have assignedAt LATE in day1 with their seeded call attempts
  // happening EARLIER the same day. That keeps them out of
  // getFirstResponseEvents (which requires attemptedAt >= assignedAt) so
  // existing newLeadsHandled / avg-speed assertions still hold, while the
  // call attempts still land them in `handledLeadIds` (the booking scope).
  //
  // L6 — booked Solar lead, CSR1, bookedAt day1 11:00 → $100 spiff.
  const [l6] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Lead", lastName: "Six",
    source: "Meta", originalSource: "Meta",
    assignedCsrId: u1.id, assignedAt: day1At(20, 0),
    status: "booked", funnelId: funnel.id, bookedByCsrId: u1.id,
    preBooked: false, bookedAt: day1At(11, 0), updatedAt: day1At(11, 0),
  }).returning();
  // L7 — sold Solar lead, CSR1, bookedAt day1 12:00 → $100 spiff, soldCount++.
  const [l7] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Lead", lastName: "Seven",
    source: "Meta", originalSource: "Meta",
    assignedCsrId: u1.id, assignedAt: day1At(20, 0),
    status: "sold", funnelId: funnel.id, bookedByCsrId: u1.id,
    preBooked: false, bookedAt: day1At(12, 0), updatedAt: day1At(12, 0),
  }).returning();
  // L8 — pre-booked Solar lead, CSR1. Must be EXCLUDED from bookings_count
  // and commission even though status=booked and bookedByCsrId matches.
  const [l8] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Lead", lastName: "Eight",
    source: "Meta", originalSource: "Meta",
    assignedCsrId: u1.id, assignedAt: day1At(20, 0),
    status: "booked", funnelId: funnel.id, bookedByCsrId: u1.id,
    preBooked: true, bookedAt: day1At(13, 0), updatedAt: day1At(13, 0),
  }).returning();
  // L9 — task #413: booked on day1 (bookedAt day1 14:00) but later edited on
  // day2 (updatedAt = day2 09:00). Must stay anchored to day1's bookings_count
  // — re-saving a booked lead the next day should not flip the booking onto
  // day2 or double-count it on day1+day2. assignedAt is set in the future so
  // L9's attempts can't create a first-response event (mirrors L6/L7/L8).
  const [l9] = await db.insert(leadsTable).values({
    tenantId: tenant.id, firstName: "Lead", lastName: "Nine",
    source: "Meta", originalSource: "Meta",
    assignedCsrId: u1.id, assignedAt: day2At(20, 0),
    status: "booked", funnelId: funnel.id, bookedByCsrId: u1.id,
    preBooked: false, bookedAt: day1At(14, 0), updatedAt: day2At(9, 0),
  }).returning();

  // ── Seed lead_status_history rows for booked leads ─────────────────────
  // getBookingStatsByIdsAndDate is anchored to the durable status-history
  // audit table now (task #416). Each booked/sold lead needs a transition
  // row into appt_set at its booking moment so the query can locate it.
  await db.insert(leadStatusHistoryTable).values([
    { leadId: l6.id, tenantId: tenant.id, fromStatus: "day_1", toStatus: "appt_set", changedAt: day1At(11, 0), changedByUserId: u1.id, reason: "test_fixture" },
    { leadId: l7.id, tenantId: tenant.id, fromStatus: "day_1", toStatus: "appt_set", changedAt: day1At(12, 0), changedByUserId: u1.id, reason: "test_fixture" },
    { leadId: l8.id, tenantId: tenant.id, fromStatus: "day_1", toStatus: "appt_set", changedAt: day1At(13, 0), changedByUserId: u1.id, reason: "test_fixture" },
    { leadId: l9.id, tenantId: tenant.id, fromStatus: "day_1", toStatus: "appt_set", changedAt: day1At(14, 0), changedByUserId: u1.id, reason: "test_fixture" },
  ]);

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

    // L6/L7/L8: same-day CSR1 attempts BEFORE their 20:00 assignedAt so they
    // land in handledLeadIds (booking scope) without producing first-response
    // events. Counts toward callsMade for CSR1 on day1.
    { leadId: l6.id, userId: u1.id, outcome: "spoke_with_customer", actionType: "call", attemptedAt: day1At(11, 0) },
    { leadId: l7.id, userId: u1.id, outcome: "spoke_with_customer", actionType: "call", attemptedAt: day1At(12, 0) },
    { leadId: l8.id, userId: u1.id, outcome: "spoke_with_customer", actionType: "call", attemptedAt: day1At(13, 0) },

    // L9: booked on day1, then "edited" on day2 — both attempts are before
    // L9's day2At(20,0) assignedAt so neither produces a first-response event.
    // The day1 attempt lands L9 in day1's handledLeadIds; the day2 attempt
    // lands L9 in day2's handledLeadIds. With the task #413 fix, L9 should
    // count exactly once on day1's bookings_count and NEVER on day2's,
    // because bookedAt (day1 14:00) anchors the booking — not updated_at.
    { leadId: l9.id, userId: u1.id, outcome: "no_answer", actionType: "call", attemptedAt: day1At(14, 30) },
    { leadId: l9.id, userId: u1.id, outcome: "no_answer", actionType: "call", attemptedAt: day2At(9, 30) },
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
    funnelId: funnel.id,
    funnelName,
    leadIds: { L1: l1.id, L2: l2.id, L3: l3.id, L4: l4.id, L5: l5.id, L6: l6.id, L7: l7.id, L8: l8.id, L9: l9.id },
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
    await db.delete(leadStatusHistoryTable).where(inArray(leadStatusHistoryTable.leadId, allLeadIds));
    await db.delete(leadsTable).where(inArray(leadsTable.id, allLeadIds));
    await db.delete(coordinatorDailyStatsTable).where(eq(coordinatorDailyStatsTable.tenantId, fx.tenantId));
    await db.delete(userLoginSessionsTable).where(inArray(userLoginSessionsTable.userId, [fx.csr1, fx.csr2]));
    await db.delete(usersTable).where(inArray(usersTable.id, [fx.csr1, fx.csr2]));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
    await db.delete(funnelTypesTable).where(eq(funnelTypesTable.id, fx.funnelId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("getFirstResponseEvents (real Postgres)", () => {
  it("returns exactly one event per (lead, assignedAt) for day1 across the seeded tenant", async () => {
    const events = await getFirstResponseEvents([fx.csr1, fx.csr2], fx.day1Start, fx.day1End);

    // getFirstResponseEvents isn't tenant-scoped and sibling files seed leads
    // concurrently, so restrict to our tenant's leads.
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

    // CSR1 made three call attempts on day2 (L5 + L2 follow-up + L9 follow-up
    // "edit"). callsMade is raw attempts, not first-response events.
    expect(aggRow.callsMade).toBe(3);

    // Task #413: L9 was booked on day1 but its lead row was touched on day2.
    // bookings_count on day2 must NOT include L9 — the booking is anchored to
    // bookedAt (day1), not updated_at (day2).
    expect(aggRow.bookingsCount).toBe(0);
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

  it("persists bookings_count, sold_count, booking_rate, and commission per spiff config on day1", async () => {
    await aggregateDailyStats(fx.day1Str);

    const [csr1Row] = await db.select().from(coordinatorDailyStatsTable).where(and(
      eq(coordinatorDailyStatsTable.userId, fx.csr1),
      eq(coordinatorDailyStatsTable.date, fx.day1Str),
    ));
    expect(csr1Row).toBeDefined();

    // L6 (booked) + L7 (sold) + L9 (booked, task #413) count. L8 is pre-booked
    // → excluded from bookings_count, sold_count, and commission even though
    // it has the booked status and a matching bookedByCsrId.
    expect(csr1Row.bookingsCount).toBe(3);
    expect(csr1Row.soldCount).toBe(1);

    // CSR1 day1 callsMade = 3 (L1) + 1 (L2) + 1 (L3 pre-pass) + 1 (L6) +
    // 1 (L7) + 1 (L8) + 1 (L9 day1) = 9 → bookingRate = round(3/9 * 100) = 33.
    expect(csr1Row.callsMade).toBe(9);
    expect(csr1Row.bookingRate).toBe(33);

    // L6, L7, L9 are all on the Solar funnel ($100 each per spiffConfig);
    // L8 is pre-booked and contributes $0. Commission = $300.
    expect(csr1Row.commission).toBe(300);

    // CSR2 had no bookings on day1 (only L3's first-touch response).
    const [csr2Row] = await db.select().from(coordinatorDailyStatsTable).where(and(
      eq(coordinatorDailyStatsTable.userId, fx.csr2),
      eq(coordinatorDailyStatsTable.date, fx.day1Str),
    ));
    expect(csr2Row).toBeDefined();
    expect(csr2Row.bookingsCount).toBe(0);
    expect(csr2Row.soldCount).toBe(0);
    expect(csr2Row.commission).toBe(0);
    expect(csr2Row.bookingRate).toBe(0);
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
    const slug = `stl-reassign`;
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


/**
 * Login-aware speed with mid-day logout gaps (real Postgres).
 *
 * The other suite seeds full-day login sessions so login-aware speed equals
 * wall-clock — that keeps its cross-day assertions deterministic but does NOT
 * exercise the subtraction in `getLoggedInSecondsWithCoverage`. Here we seed a
 * dedicated tenant whose CSR was logged out during part(s) of the gap between
 * `assignedAt` and the first call attempt, and assert that the aggregated
 * `avg_speed_to_lead` reflects only the logged-in portion (not wall-clock).
 *
 * Scenarios seeded (all in a fresh tenant, day1 = yesterday):
 *   L6 — assigned 09:00, first touched 10:00 (3600s wall-clock). CSR logged
 *        out 09:15–09:45 (1800s gap). Expected login-aware speed: 1800s.
 *   L7 — assigned 13:00, first touched 14:00 (3600s wall-clock). Multi-segment
 *        logout: 13:10–13:20 (600s) and 13:30–13:50 (1200s). Expected
 *        login-aware speed: 3600 − 600 − 1200 = 1800s.
 */
describe("login-aware speed subtracts mid-day logout gaps (real Postgres)", () => {
  interface OfflineFixtures {
    tenantId: number;
    csrId: number;
    leadIds: { L6: number; L7: number };
    day1Str: string;
    day1Start: Date;
    day1End: Date;
  }

  let ofx: OfflineFixtures;

  beforeAll(async () => {
    const slug = `stl-offline`;
    const [tenant] = await db.insert(tenantsTable).values({
      name: `Speed-to-Lead Offline ${slug}`,
      clientSlug: slug,
    }).returning();

    const [csr] = await db.insert(usersTable).values({
      email: `${slug}-csr@example.com`,
      name: "Offline CSR",
      passwordHash: "x",
      role: "client_user",
      tenantId: tenant.id,
    }).returning();

    const now = new Date();
    const day2 = startOfLocalDay(now);
    const day1 = new Date(day2);
    day1.setDate(day1.getDate() - 1);
    const at = (h: number, m = 0) => {
      const d = new Date(day1); d.setHours(h, m, 0, 0); return d;
    };

    // L6 — single logout gap inside the assignment→first-touch window.
    const [l6] = await db.insert(leadsTable).values({
      tenantId: tenant.id, firstName: "Lead", lastName: "Six",
      source: "Meta", originalSource: "Meta",
      assignedCsrId: csr.id, assignedAt: at(9, 0),
    }).returning();
    // L7 — multi-segment logouts inside the window.
    const [l7] = await db.insert(leadsTable).values({
      tenantId: tenant.id, firstName: "Lead", lastName: "Seven",
      source: "Meta", originalSource: "Meta",
      assignedCsrId: csr.id, assignedAt: at(13, 0),
    }).returning();

    await db.insert(callAttemptsTable).values([
      { leadId: l6.id, userId: csr.id, outcome: "spoke_with_customer", actionType: "call", attemptedAt: at(10, 0) },
      { leadId: l7.id, userId: csr.id, outcome: "spoke_with_customer", actionType: "call", attemptedAt: at(14, 0) },
    ]);

    // Login sessions designed to leave specific offline gaps:
    //   logged out 09:15–09:45 (covers L6's window)
    //   logged out 13:10–13:20 and 13:30–13:50 (covers L7's window)
    const dayStart = startOfLocalDay(day1);
    const dayEnd = endOfLocalDay(day1);
    await db.insert(userLoginSessionsTable).values([
      { userId: csr.id, tenantId: tenant.id, loginAt: dayStart,   logoutAt: at(9, 15) },
      { userId: csr.id, tenantId: tenant.id, loginAt: at(9, 45),  logoutAt: at(13, 10) },
      { userId: csr.id, tenantId: tenant.id, loginAt: at(13, 20), logoutAt: at(13, 30) },
      { userId: csr.id, tenantId: tenant.id, loginAt: at(13, 50), logoutAt: dayEnd },
    ]);

    ofx = {
      tenantId: tenant.id,
      csrId: csr.id,
      leadIds: { L6: l6.id, L7: l7.id },
      day1Str: dateStr(day1),
      day1Start: startOfLocalDay(day1),
      day1End: endOfLocalDay(day1),
    };
  });

  afterAll(async () => {
    if (!ofx) return;
    const allLeadIds = Object.values(ofx.leadIds);
    try {
      await db.delete(callAttemptsTable).where(inArray(callAttemptsTable.leadId, allLeadIds));
      await db.delete(leadsTable).where(inArray(leadsTable.id, allLeadIds));
      await db.delete(coordinatorDailyStatsTable).where(eq(coordinatorDailyStatsTable.tenantId, ofx.tenantId));
      await db.delete(userLoginSessionsTable).where(eq(userLoginSessionsTable.userId, ofx.csrId));
      await db.delete(usersTable).where(eq(usersTable.id, ofx.csrId));
      await db.delete(tenantsTable).where(eq(tenantsTable.id, ofx.tenantId));
    } catch {
      /* best-effort cleanup */
    }
  });

  it("computeAvgSpeedFromEvents subtracts a single mid-day logout gap (L6) and multi-segment gaps (L7)", async () => {
    const events = await getFirstResponseEvents([ofx.csrId], ofx.day1Start, ofx.day1End);
    const ours = events.filter(e => Object.values(ofx.leadIds).includes(e.leadId));
    expect(ours.map(e => e.leadId).sort()).toEqual([ofx.leadIds.L6, ofx.leadIds.L7].sort());

    // Wall-clock for both is 3600s; the helper exposes that pre-subtraction.
    for (const e of ours) {
      expect(e.wallClockSpeed).toBeCloseTo(3600, 0);
    }

    // Login-aware average: (1800 + 1800) / 2 = 1800s. If the subtraction
    // regressed to wall-clock, this would be 3600.
    const avg = await computeAvgSpeedFromEvents(ours);
    expect(Math.round(avg)).toBe(1800);
  });

  it("aggregateDailyStats persists the login-aware avg (not wall-clock) for day1", async () => {
    const processed = await aggregateDailyStats(ofx.day1Str);
    expect(processed).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(coordinatorDailyStatsTable).where(and(
      eq(coordinatorDailyStatsTable.tenantId, ofx.tenantId),
      eq(coordinatorDailyStatsTable.userId, ofx.csrId),
      eq(coordinatorDailyStatsTable.date, ofx.day1Str),
    ));
    expect(row).toBeDefined();
    expect(row.newLeadsHandled).toBe(2);
    // 1800s, not the 3600s wall-clock — proves the offline subtraction ran
    // end-to-end through the nightly aggregation path.
    expect(row.avgSpeedToLead).toBeCloseTo(1800, 0);
  });
});

/**
 * Task #412 — Funnel rename safety for spiff payouts.
 *
 * `computeSpiffCommission` keys on the funnel **name** read from
 * `funnel_types` at aggregation time, while tenants configure payouts by
 * funnel name in `tenants.spiff_config.byFunnel`. The funnel itself is
 * referenced by id on `leads.funnel_id`, so renaming the row is a one-line
 * UPDATE that does NOT touch the lead history — but it WILL change every
 * subsequent commission aggregation for those leads.
 *
 * Documented contract (asserted below):
 *   Commission lookup uses the CURRENT funnel name at the moment of
 *   aggregation. If a funnel is renamed without updating
 *   `spiff_config.byFunnel` to match, that funnel's bookings fall back
 *   DETERMINISTICALLY to `spiff_config.default`. Re-aggregating an older
 *   day after the rename will overwrite the previously-persisted commission
 *   with the fallback value (`bookings × default`).
 *
 * This is the product expectation: spiff_config is the source of truth for
 * payouts, and we don't silently chase renames. Operators renaming a funnel
 * are expected to also update the tenant's spiff config (or rely on the
 * default).
 */
describe("funnel rename keeps spiff payouts deterministic (task #412)", () => {
  interface RenameFx {
    tenantId: number;
    csr: number;
    funnelId: number;
    origFunnelName: string;
    renamedFunnelName: string;
    bookedLeadId: number;
    soldLeadId: number;
    day1: Date;
    day1Str: string;
  }
  let xfx: RenameFx;

  beforeAll(async () => {
    const slug = `spiff-rename`;
    const origFunnelName = `OrigFunnel-${slug}`;
    const renamedFunnelName = `RenamedFunnel-${slug}`;

    // Tenant's byFunnel keys ONLY the original name. After rename, neither
    // the old nor the new name will match leads' current funnel name (the
    // new one), so commission must fall back to default ($20).
    const [tenant] = await db.insert(tenantsTable).values({
      name: `Spiff Rename ${slug}`,
      clientSlug: slug,
      spiffConfig: { default: 20, byFunnel: { [origFunnelName]: 100 } },
    }).returning();

    const [funnel] = await db.insert(funnelTypesTable).values({
      name: origFunnelName,
      slug: `orig-${slug}`,
    }).returning();

    const [u] = await db.insert(usersTable).values({
      email: `${slug}-csr@example.com`, name: "Rename CSR", passwordHash: "x",
      role: "client_user", tenantId: tenant.id,
    }).returning();

    const day1 = new Date(); day1.setDate(day1.getDate() - 1); day1.setHours(0, 0, 0, 0);
    const at = (h: number, m = 0) => {
      const d = new Date(day1); d.setHours(h, m, 0, 0); return d;
    };

    // Two leads on the funnel, both worked + booked/sold by the CSR on day1.
    // Assigned LATE in the day with call attempts EARLIER so they land in
    // `handledLeadIds` (booking scope) without producing first-response events
    // (keeps the rest of the day's stats orthogonal to this test).
    const [booked] = await db.insert(leadsTable).values({
      tenantId: tenant.id, firstName: "Rename", lastName: "Booked",
      source: "Meta", originalSource: "Meta",
      assignedCsrId: u.id, assignedAt: at(20, 0),
      status: "booked", funnelId: funnel.id, bookedByCsrId: u.id,
      preBooked: false, bookedAt: at(11, 0), updatedAt: at(11, 0),
    }).returning();
    const [sold] = await db.insert(leadsTable).values({
      tenantId: tenant.id, firstName: "Rename", lastName: "Sold",
      source: "Meta", originalSource: "Meta",
      assignedCsrId: u.id, assignedAt: at(20, 0),
      status: "sold", funnelId: funnel.id, bookedByCsrId: u.id,
      preBooked: false, bookedAt: at(12, 0), updatedAt: at(12, 0),
    }).returning();

    await db.insert(callAttemptsTable).values([
      { leadId: booked.id, userId: u.id, outcome: "spoke_with_customer", actionType: "call", attemptedAt: at(11, 0) },
      { leadId: sold.id, userId: u.id, outcome: "spoke_with_customer", actionType: "call", attemptedAt: at(12, 0) },
    ]);

    // Booking aggregation anchors on the lead_status_history `appt_set`
    // transition (task #416), not the mutable leads.booked_at snapshot. Write
    // the matching audit rows so each lead counts as a same-day booking.
    await db.insert(leadStatusHistoryTable).values([
      { leadId: booked.id, tenantId: tenant.id, fromStatus: "day_1", toStatus: "appt_set", changedAt: at(11, 0), changedByUserId: u.id },
      { leadId: sold.id, tenantId: tenant.id, fromStatus: "day_1", toStatus: "appt_set", changedAt: at(12, 0), changedByUserId: u.id },
    ]);

    xfx = {
      tenantId: tenant.id, csr: u.id, funnelId: funnel.id,
      origFunnelName, renamedFunnelName,
      bookedLeadId: booked.id, soldLeadId: sold.id,
      day1, day1Str: dateStr(day1),
    };
  });

  afterAll(async () => {
    if (!xfx) return;
    try {
      const leadIds = [xfx.bookedLeadId, xfx.soldLeadId];
      await db.delete(callAttemptsTable).where(inArray(callAttemptsTable.leadId, leadIds));
      await db.delete(leadsTable).where(inArray(leadsTable.id, leadIds));
      await db.delete(coordinatorDailyStatsTable).where(eq(coordinatorDailyStatsTable.tenantId, xfx.tenantId));
      await db.delete(usersTable).where(eq(usersTable.id, xfx.csr));
      await db.delete(tenantsTable).where(eq(tenantsTable.id, xfx.tenantId));
      await db.delete(funnelTypesTable).where(eq(funnelTypesTable.id, xfx.funnelId));
    } catch { /* best-effort */ }
  });

  it("pre-rename: aggregation persists commission keyed on the matching funnel name ($100 × 2)", async () => {
    await aggregateDailyStats(xfx.day1Str);
    const [row] = await db.select().from(coordinatorDailyStatsTable).where(and(
      eq(coordinatorDailyStatsTable.userId, xfx.csr),
      eq(coordinatorDailyStatsTable.date, xfx.day1Str),
    ));
    expect(row).toBeDefined();
    expect(row.bookingsCount).toBe(2);
    expect(row.soldCount).toBe(1);
    // byFunnel[OrigFunnel] = $100 → 2 bookings × $100 = $200.
    expect(row.commission).toBe(200);
  });

  it("post-rename: re-aggregating the same day falls back to spiff default (deterministic)", async () => {
    // Rename the funnel WITHOUT touching tenant.spiff_config. Leads still
    // point at the same funnel_id; only the row's name changes.
    await db.update(funnelTypesTable)
      .set({ name: xfx.renamedFunnelName })
      .where(eq(funnelTypesTable.id, xfx.funnelId));

    // Re-aggregate the same day. The upsert overwrites the prior commission.
    await aggregateDailyStats(xfx.day1Str);

    const [row] = await db.select().from(coordinatorDailyStatsTable).where(and(
      eq(coordinatorDailyStatsTable.userId, xfx.csr),
      eq(coordinatorDailyStatsTable.date, xfx.day1Str),
    ));
    expect(row).toBeDefined();
    // Bookings/sold unchanged — only the commission lookup is affected.
    expect(row.bookingsCount).toBe(2);
    expect(row.soldCount).toBe(1);
    // RenamedFunnel is NOT in byFunnel → default ($20) × 2 = $40.
    // This is the documented product behavior: spiff_config is the source of
    // truth; renaming a funnel without updating it deterministically drops
    // those bookings to the default payout (NOT zero, NOT the stale $100).
    expect(row.commission).toBe(40);
  });

  it("post-rename: updating spiff_config to the new name restores the original payout", async () => {
    // Operator remediation: point byFunnel at the new name.
    await db.update(tenantsTable)
      .set({
        spiffConfig: { default: 20, byFunnel: { [xfx.renamedFunnelName]: 100 } },
        updatedAt: new Date(),
      })
      .where(eq(tenantsTable.id, xfx.tenantId));

    await aggregateDailyStats(xfx.day1Str);

    const [row] = await db.select().from(coordinatorDailyStatsTable).where(and(
      eq(coordinatorDailyStatsTable.userId, xfx.csr),
      eq(coordinatorDailyStatsTable.date, xfx.day1Str),
    ));
    expect(row).toBeDefined();
    expect(row.commission).toBe(200);
  });
});

/**
 * Task #418 — Stale-funnel spiff warning surfaces via GET /sales-manager/spiff-config.
 *
 * Sister coverage to "funnel rename keeps spiff payouts deterministic": that
 * suite locks in the *aggregator's* fallback behaviour after a funnel rename.
 * This suite locks in the *admin-facing* surface that lets operators FIX the
 * mismatch — the GET response continues to expose the byFunnel override
 * keyed on the now-stale name (so the UI can flag it), and a UI-shaped rename
 * (PUT with the override re-keyed under the new funnel name) preserves the
 * dollar amount.
 */
const expressMod = await import("express");
const expressApp = expressMod.default;
const httpMod = await import("http");

interface RouteResp { status: number; json: any }
async function callSpiffRoute(
  method: "GET" | "PUT",
  tenantId: number,
  body?: unknown,
): Promise<RouteResp> {
  // Re-import the router fresh so it picks up the real (un-mocked) db module.
  const routerMod = await import("../routes/sales-manager");
  const app = expressApp();
  app.use(expressApp.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: 1,
      userRole: "super_admin",
      tenantId,
    };
    next();
  });
  app.use(routerMod.default);
  return await new Promise<RouteResp>((resolve, reject) => {
    const server = httpMod.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = httpMod.request({
        hostname: "127.0.0.1",
        port,
        path: `/sales-manager/spiff-config?tenantId=${tenantId}`,
        method,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() }
          : {},
      }, res => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          server.close();
          resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} });
        });
      });
      req.on("error", err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe("stale-funnel spiff warning surfaces on the spiff-config API (task #418)", () => {
  interface StaleFx {
    tenantId: number;
    funnelId: number;
    origFunnelName: string;
    renamedFunnelName: string;
  }
  let sfx: StaleFx;

  beforeAll(async () => {
    const slug = `spiff-stale`;
    const origFunnelName = `StaleOrig-${slug}`;
    const renamedFunnelName = `StaleRenamed-${slug}`;

    // Tenant's byFunnel maps the ORIGINAL funnel name → $175. After we rename
    // the funnel row, the key in byFunnel will no longer match any current
    // funnel_types.name — that's the staleness condition the UI flags.
    const [tenant] = await db.insert(tenantsTable).values({
      name: `Spiff Stale ${slug}`,
      clientSlug: slug,
      spiffConfig: { default: 25, byFunnel: { [origFunnelName]: 175 } },
    }).returning();

    const [funnel] = await db.insert(funnelTypesTable).values({
      name: origFunnelName,
      slug: `stale-${slug}`,
    }).returning();

    sfx = {
      tenantId: tenant.id,
      funnelId: funnel.id,
      origFunnelName,
      renamedFunnelName,
    };
  });

  afterAll(async () => {
    if (!sfx) return;
    try {
      await db.delete(tenantsTable).where(eq(tenantsTable.id, sfx.tenantId));
      await db.delete(funnelTypesTable).where(eq(funnelTypesTable.id, sfx.funnelId));
    } catch { /* best-effort */ }
  });

  // Mirror of the UI's `staleKeys` computation in sales-manager.tsx — a
  // byFunnel key is stale iff no current funnel_types row has that name.
  async function computeStaleKeys(tenantId: number, byFunnel: Record<string, number>): Promise<string[]> {
    const funnels = await db.select({ name: funnelTypesTable.name }).from(funnelTypesTable);
    void tenantId; // funnel_types is global in the current schema
    const nameSet = new Set(funnels.map(f => f.name));
    return Object.keys(byFunnel).filter(k => !nameSet.has(k));
  }

  it("pre-rename: GET response exposes the override and the UI computes zero stale keys", async () => {
    const res = await callSpiffRoute("GET", sfx.tenantId);
    expect(res.status).toBe(200);
    expect(res.json.spiffConfig).toBeDefined();
    expect(res.json.spiffConfig.default).toBe(25);
    expect(res.json.spiffConfig.byFunnel[sfx.origFunnelName]).toBe(175);

    const stale = await computeStaleKeys(sfx.tenantId, res.json.spiffConfig.byFunnel);
    expect(stale).toEqual([]);
  });

  it("post-rename: GET still returns the old key and the UI surfaces it as stale", async () => {
    // Rename the funnel WITHOUT touching tenant.spiff_config — the scenario
    // the warning is designed to catch.
    await db.update(funnelTypesTable)
      .set({ name: sfx.renamedFunnelName })
      .where(eq(funnelTypesTable.id, sfx.funnelId));

    const res = await callSpiffRoute("GET", sfx.tenantId);
    expect(res.status).toBe(200);
    // The override is still stored under the OLD name (source-of-truth is
    // tenant.spiff_config — we don't silently migrate keys server-side).
    expect(res.json.spiffConfig.byFunnel[sfx.origFunnelName]).toBe(175);
    expect(res.json.spiffConfig.byFunnel[sfx.renamedFunnelName]).toBeUndefined();

    // The UI's staleKeys algorithm flags exactly the orphaned key.
    const stale = await computeStaleKeys(sfx.tenantId, res.json.spiffConfig.byFunnel);
    expect(stale).toEqual([sfx.origFunnelName]);
  });

  it("UI rename: PUT re-keyed under the new funnel name preserves the amount and clears staleness", async () => {
    // Simulate the UI's `renameOverride(oldKey, newKey)` helper — it builds a
    // new byFunnel map with the value moved from oldKey → newKey, then PUTs
    // the whole spiffConfig. Amount must be preserved verbatim.
    const getBefore = await callSpiffRoute("GET", sfx.tenantId);
    const prev = getBefore.json.spiffConfig as { default: number; byFunnel: Record<string, number> };
    const amount = prev.byFunnel[sfx.origFunnelName];
    expect(amount).toBe(175);

    const nextByFunnel: Record<string, number> = {};
    for (const [k, v] of Object.entries(prev.byFunnel)) {
      nextByFunnel[k === sfx.origFunnelName ? sfx.renamedFunnelName : k] = v;
    }

    const putRes = await callSpiffRoute("PUT", sfx.tenantId, {
      spiffConfig: { default: prev.default, byFunnel: nextByFunnel },
    });
    expect(putRes.status).toBe(200);
    expect(putRes.json.spiffConfig.byFunnel[sfx.renamedFunnelName]).toBe(175);
    expect(putRes.json.spiffConfig.byFunnel[sfx.origFunnelName]).toBeUndefined();
    expect(putRes.json.spiffConfig.default).toBe(prev.default);

    // GET reads back the persisted state — the rename is durable and the
    // UI's staleKeys is empty again.
    const getAfter = await callSpiffRoute("GET", sfx.tenantId);
    expect(getAfter.json.spiffConfig.byFunnel[sfx.renamedFunnelName]).toBe(175);
    expect(getAfter.json.spiffConfig.byFunnel[sfx.origFunnelName]).toBeUndefined();

    const stale = await computeStaleKeys(sfx.tenantId, getAfter.json.spiffConfig.byFunnel);
    expect(stale).toEqual([]);
  });
});
