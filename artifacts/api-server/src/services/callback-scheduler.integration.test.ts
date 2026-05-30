/**
 * Real-Postgres integration test for the callback reminder sweep
 * (`checkDueCallbacks` in `callback-scheduler.ts`).
 *
 * The sweep pages through due callbacks and marks each one notified as it goes,
 * which removes that row from the "still-unnotified due" result set. The old
 * implementation advanced a LIMIT/OFFSET cursor while doing this — so once the
 * rows it had already processed left the set, the remaining due rows shifted up
 * into the offsets it had already skipped past, and entire batches of due
 * callbacks were silently never notified (no reminder ever fired).
 *
 * The fix re-queries the first page of still-unnotified due leads until none
 * remain, guaranteeing every due callback is processed exactly once regardless
 * of how many pages of due rows exist.
 *
 * This test seeds MORE due callbacks than a single page (pageSize = 50) for a
 * throwaway tenant, runs one sweep, and asserts that EVERY seeded due lead is
 * notified — a regression to offset paging would leave the leads beyond the
 * first page un-notified and trip this test.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray, and, isNotNull } from "drizzle-orm";

// The push enqueue and socket emit are side effects we don't want to exercise
// against real infra here; mock them so we can also count exactly how many
// reminders the sweep fired. `vi.hoisted` is required because `vi.mock` is
// hoisted above ordinary top-level declarations — the spies must be created in
// the same hoisted phase to be referenceable inside the mock factories.
const { enqueueSpy, emitSpy } = vi.hoisted(() => ({
  enqueueSpy: vi.fn(async (..._args: unknown[]) => {}),
  emitSpy: vi.fn((..._args: unknown[]) => {}),
}));

vi.mock("./push-notification-jobs", () => ({
  enqueueSendPushToUser: (...args: unknown[]) => enqueueSpy(...args),
}));
vi.mock("../socket", () => ({
  emitCallbackDue: (...args: unknown[]) => emitSpy(...args),
}));

const dbModule = await import("@workspace/db");
const { db, tenantsTable, usersTable, leadsTable } = dbModule;
const { checkDueCallbacks } = await import("./callback-scheduler");

// Comfortably more than two pages (the sweep uses a page size of 50) so a
// skip-the-second-batch regression cannot hide behind an exactly-one-page seed.
const DUE_COUNT = 120;

interface Fx {
  tenantId: number;
  csrId: number;
  dueIds: number[];
  // Controls that must NOT be notified by the sweep.
  notDueId: number; // callbackAt in the future
  deadId: number; // due but hubStatus = dead
  unassignedId: number; // due but no assigned CSR
}

let fx: Fx;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const slug = `cb-sweep`;
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ name: `Callback Sweep Int ${slug}`, clientSlug: slug })
    .returning();
  const [csr] = await db
    .insert(usersTable)
    .values({
      email: `${slug}-csr@example.com`,
      name: "CSR",
      passwordHash: "x",
      role: "client_user",
      tenantId: tenant.id,
    })
    .returning();

  const now = Date.now();
  const past = (mins: number) => new Date(now - mins * 60 * 1000);
  const future = (mins: number) => new Date(now + mins * 60 * 1000);

  // Seed DUE_COUNT due, unnotified, assigned, non-dead callbacks. Give them a
  // SHARED callbackAt so the id tiebreaker is what produces a stable order —
  // the exact scenario the paging fix has to survive.
  const dueIds: number[] = [];
  for (let i = 0; i < DUE_COUNT; i++) {
    const [lead] = await db
      .insert(leadsTable)
      .values({
        tenantId: tenant.id,
        firstName: "Due",
        lastName: `Lead${i}`,
        source: "Meta",
        originalSource: "Meta",
        hubStatus: "day_1",
        assignedCsrId: csr.id,
        callbackAt: past(10),
        callbackNotifiedAt: null,
      })
      .returning({ id: leadsTable.id });
    dueIds.push(lead.id);
  }

  // Control: not yet due (callbackAt in the future).
  const [notDue] = await db
    .insert(leadsTable)
    .values({
      tenantId: tenant.id,
      firstName: "Not",
      lastName: "Due",
      source: "Meta",
      originalSource: "Meta",
      hubStatus: "day_1",
      assignedCsrId: csr.id,
      callbackAt: future(60),
      callbackNotifiedAt: null,
    })
    .returning({ id: leadsTable.id });

  // Control: due but dead — the sweep excludes dead leads.
  const [dead] = await db
    .insert(leadsTable)
    .values({
      tenantId: tenant.id,
      firstName: "Dead",
      lastName: "Due",
      source: "Meta",
      originalSource: "Meta",
      hubStatus: "dead",
      assignedCsrId: csr.id,
      callbackAt: past(10),
      callbackNotifiedAt: null,
    })
    .returning({ id: leadsTable.id });

  // Control: due but unassigned — the sweep requires an assigned CSR.
  const [unassigned] = await db
    .insert(leadsTable)
    .values({
      tenantId: tenant.id,
      firstName: "Unassigned",
      lastName: "Due",
      source: "Meta",
      originalSource: "Meta",
      hubStatus: "day_1",
      assignedCsrId: null,
      callbackAt: past(10),
      callbackNotifiedAt: null,
    })
    .returning({ id: leadsTable.id });

  fx = {
    tenantId: tenant.id,
    csrId: csr.id,
    dueIds,
    notDueId: notDue.id,
    deadId: dead.id,
    unassignedId: unassigned.id,
  };
});

afterAll(async () => {
  if (!fx) return;
  try {
    await db.delete(leadsTable).where(eq(leadsTable.tenantId, fx.tenantId));
    await db.delete(usersTable).where(eq(usersTable.id, fx.csrId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("checkDueCallbacks — multi-page due sweep (real Postgres)", () => {
  it("notifies every due callback across more than one page, with no skips", async () => {
    await checkDueCallbacks();

    // Every seeded due lead must now be notified (callbackNotifiedAt >= callbackAt).
    const rows = await db
      .select({
        id: leadsTable.id,
        callbackAt: leadsTable.callbackAt,
        callbackNotifiedAt: leadsTable.callbackNotifiedAt,
      })
      .from(leadsTable)
      .where(inArray(leadsTable.id, fx.dueIds));

    expect(rows).toHaveLength(DUE_COUNT);
    const unnotified = rows.filter(
      (r) =>
        r.callbackNotifiedAt === null ||
        (r.callbackAt !== null && r.callbackNotifiedAt < r.callbackAt),
    );
    expect(
      unnotified.map((r) => r.id),
      "every due callback must be notified — un-notified rows mean the sweep skipped a page",
    ).toEqual([]);

    // The sweep fired exactly one reminder per due lead (no dupes, no skips).
    const notifiedDueLeadIds = enqueueSpy.mock.calls
      .map((c) => (c[0] as { data: { leadId: number } }).data.leadId)
      .filter((id) => fx.dueIds.includes(id));
    expect(new Set(notifiedDueLeadIds).size).toBe(DUE_COUNT);
    expect(notifiedDueLeadIds.length).toBe(DUE_COUNT);

    // The socket emit mirrors the push enqueue one-to-one for our due leads.
    const emittedDueLeadIds = emitSpy.mock.calls
      .map((c) => (c[1] as { leadId: number }).leadId)
      .filter((id) => fx.dueIds.includes(id));
    expect(new Set(emittedDueLeadIds).size).toBe(DUE_COUNT);
  });

  it("leaves not-yet-due, dead, and unassigned callbacks untouched", async () => {
    const controls = await db
      .select({
        id: leadsTable.id,
        callbackNotifiedAt: leadsTable.callbackNotifiedAt,
      })
      .from(leadsTable)
      .where(inArray(leadsTable.id, [fx.notDueId, fx.deadId, fx.unassignedId]));

    for (const row of controls) {
      expect(
        row.callbackNotifiedAt,
        `control lead ${row.id} must not be notified by the sweep`,
      ).toBeNull();
    }

    // And none of them produced a reminder.
    const controlIds = [fx.notDueId, fx.deadId, fx.unassignedId];
    const firedForControls = enqueueSpy.mock.calls
      .map((c) => (c[0] as { data: { leadId: number } }).data.leadId)
      .filter((id) => controlIds.includes(id));
    expect(firedForControls).toEqual([]);
  });

  it("is idempotent — a second sweep fires no new reminders", async () => {
    enqueueSpy.mockClear();
    emitSpy.mockClear();

    await checkDueCallbacks();

    const refired = enqueueSpy.mock.calls
      .map((c) => (c[0] as { data: { leadId: number } }).data.leadId)
      .filter((id) => fx.dueIds.includes(id));
    expect(
      refired,
      "already-notified due callbacks must not be reminded again on a later sweep",
    ).toEqual([]);
  });
});

/**
 * Concurrency contract: if a scheduler tick takes longer than its interval, two
 * `checkDueCallbacks()` sweeps can run at once against the same due leads. The
 * conditional "claim" UPDATE (set callbackNotifiedAt WHERE it is still
 * unnotified, then `.returning()`) is what guarantees only ONE sweep ever
 * claims a given lead: under Postgres READ COMMITTED, when both sweeps UPDATE
 * the same row, the second blocks until the first commits, then re-evaluates
 * its WHERE against the now-notified row, matches nothing, and returns zero
 * rows — so it skips firing a reminder. This test pins that contract so a
 * future refactor (e.g. dropping the conditional WHERE or the `.returning()`
 * guard) that reintroduced duplicate push notifications would fail here.
 */
const CONCURRENT_DUE_COUNT = 150;

interface ConcurrentFx {
  tenantId: number;
  csrId: number;
  dueIds: number[];
}

let cfx: ConcurrentFx;

describe("checkDueCallbacks — overlapping concurrent sweeps (real Postgres)", () => {
  beforeAll(async () => {
    const slug = `cb-race`;
    const [tenant] = await db
      .insert(tenantsTable)
      .values({ name: `Callback Race Int ${slug}`, clientSlug: slug })
      .returning();
    const [csr] = await db
      .insert(usersTable)
      .values({
        email: `${slug}-csr@example.com`,
        name: "CSR",
        passwordHash: "x",
        role: "client_user",
        tenantId: tenant.id,
      })
      .returning();

    const past = (mins: number) => new Date(Date.now() - mins * 60 * 1000);

    // Seed more than two pages of due, unnotified, assigned, non-dead callbacks
    // with a SHARED callbackAt so the two sweeps contend on the exact same rows
    // in the exact same order — the worst case for the claim race.
    const dueIds: number[] = [];
    for (let i = 0; i < CONCURRENT_DUE_COUNT; i++) {
      const [lead] = await db
        .insert(leadsTable)
        .values({
          tenantId: tenant.id,
          firstName: "Race",
          lastName: `Lead${i}`,
          source: "Meta",
          originalSource: "Meta",
          hubStatus: "day_1",
          assignedCsrId: csr.id,
          callbackAt: past(10),
          callbackNotifiedAt: null,
        })
        .returning({ id: leadsTable.id });
      dueIds.push(lead.id);
    }

    cfx = { tenantId: tenant.id, csrId: csr.id, dueIds };
  });

  afterAll(async () => {
    if (!cfx) return;
    try {
      await db.delete(leadsTable).where(eq(leadsTable.tenantId, cfx.tenantId));
      await db.delete(usersTable).where(eq(usersTable.id, cfx.csrId));
      await db.delete(tenantsTable).where(eq(tenantsTable.id, cfx.tenantId));
    } catch {
      /* best-effort cleanup */
    }
  });

  it("fires exactly one reminder per due callback when two sweeps overlap", async () => {
    enqueueSpy.mockClear();
    emitSpy.mockClear();

    // Run two sweeps concurrently — they interleave on the event loop at every
    // awaited query, so both genuinely race to claim the same due rows.
    await Promise.all([checkDueCallbacks(), checkDueCallbacks()]);

    // Every seeded due lead must be notified exactly once at the DB level.
    const rows = await db
      .select({
        id: leadsTable.id,
        callbackAt: leadsTable.callbackAt,
        callbackNotifiedAt: leadsTable.callbackNotifiedAt,
      })
      .from(leadsTable)
      .where(inArray(leadsTable.id, cfx.dueIds));

    expect(rows).toHaveLength(CONCURRENT_DUE_COUNT);
    const unnotified = rows.filter(
      (r) =>
        r.callbackNotifiedAt === null ||
        (r.callbackAt !== null && r.callbackNotifiedAt < r.callbackAt),
    );
    expect(
      unnotified.map((r) => r.id),
      "every due callback must be notified — overlapping sweeps must not skip any",
    ).toEqual([]);

    // The claim guarantees exactly one push reminder per due lead: no row was
    // claimed (and thus notified) twice, and none was skipped.
    const notifiedDueLeadIds = enqueueSpy.mock.calls
      .map((c) => (c[0] as { data: { leadId: number } }).data.leadId)
      .filter((id) => cfx.dueIds.includes(id));
    expect(
      notifiedDueLeadIds.length,
      "total reminders must equal the number of due leads — extras mean a double-fire",
    ).toBe(CONCURRENT_DUE_COUNT);
    expect(
      new Set(notifiedDueLeadIds).size,
      "each due lead must be reminded exactly once across both sweeps",
    ).toBe(CONCURRENT_DUE_COUNT);

    // The socket emit mirrors the push enqueue one-to-one — also exactly once each.
    const emittedDueLeadIds = emitSpy.mock.calls
      .map((c) => (c[1] as { leadId: number }).leadId)
      .filter((id) => cfx.dueIds.includes(id));
    expect(emittedDueLeadIds.length).toBe(CONCURRENT_DUE_COUNT);
    expect(new Set(emittedDueLeadIds).size).toBe(CONCURRENT_DUE_COUNT);
  });
});

/**
 * Reschedule contract: a callback can be moved to a NEW time after it has
 * already been reminded. The sweep's re-notify condition is
 * `callbackNotifiedAt < callbackAt`, so bumping `callbackAt` to a fresh value
 * that is *after* the last notification (but still in the past, i.e. due
 * again) MUST make the next sweep fire exactly one fresh reminder — no more,
 * no less. This guards both failure modes: a regression that dropped the
 * `callbackNotifiedAt < callbackAt` clause would never re-remind a rescheduled
 * callback, while one that re-fired purely on "due + previously notified"
 * could double-fire. We deliberately derive the new `callbackAt` from the
 * stored `callbackNotifiedAt` (+1ms) so it is provably greater than the last
 * notification and provably in the past — no reliance on wall-clock sleeps.
 */
interface RescheduleFx {
  tenantId: number;
  csrId: number;
  leadId: number;
}

let rfx: RescheduleFx;

describe("checkDueCallbacks — rescheduled callback re-fires once (real Postgres)", () => {
  beforeAll(async () => {
    const slug = `cb-resched`;
    const [tenant] = await db
      .insert(tenantsTable)
      .values({ name: `Callback Resched Int ${slug}`, clientSlug: slug })
      .returning();
    const [csr] = await db
      .insert(usersTable)
      .values({
        email: `${slug}-csr@example.com`,
        name: "CSR",
        passwordHash: "x",
        role: "client_user",
        tenantId: tenant.id,
      })
      .returning();

    const [lead] = await db
      .insert(leadsTable)
      .values({
        tenantId: tenant.id,
        firstName: "Resched",
        lastName: "Lead",
        source: "Meta",
        originalSource: "Meta",
        hubStatus: "day_1",
        assignedCsrId: csr.id,
        callbackAt: new Date(Date.now() - 10 * 60 * 1000),
        callbackNotifiedAt: null,
      })
      .returning({ id: leadsTable.id });

    rfx = { tenantId: tenant.id, csrId: csr.id, leadId: lead.id };
  });

  afterAll(async () => {
    if (!rfx) return;
    try {
      await db.delete(leadsTable).where(eq(leadsTable.tenantId, rfx.tenantId));
      await db.delete(usersTable).where(eq(usersTable.id, rfx.csrId));
      await db.delete(tenantsTable).where(eq(tenantsTable.id, rfx.tenantId));
    } catch {
      /* best-effort cleanup */
    }
  });

  it("fires exactly one fresh reminder after the callback is moved to a new due time", async () => {
    enqueueSpy.mockClear();
    emitSpy.mockClear();

    // First sweep: the brand-new due callback is reminded once.
    await checkDueCallbacks();

    const firstFire = enqueueSpy.mock.calls
      .map((c) => (c[0] as { data: { leadId: number } }).data.leadId)
      .filter((id) => id === rfx.leadId);
    expect(
      firstFire.length,
      "a freshly-due callback must fire exactly one reminder on the first sweep",
    ).toBe(1);

    const [afterFirst] = await db
      .select({ callbackNotifiedAt: leadsTable.callbackNotifiedAt })
      .from(leadsTable)
      .where(eq(leadsTable.id, rfx.leadId));
    expect(afterFirst.callbackNotifiedAt).not.toBeNull();
    const notifiedAt = afterFirst.callbackNotifiedAt as Date;

    // An immediate re-sweep with no change fires nothing — the lead is already
    // notified for its current callbackAt.
    enqueueSpy.mockClear();
    emitSpy.mockClear();
    await checkDueCallbacks();
    expect(
      enqueueSpy.mock.calls
        .map((c) => (c[0] as { data: { leadId: number } }).data.leadId)
        .filter((id) => id === rfx.leadId),
      "an unchanged, already-notified callback must not re-fire",
    ).toEqual([]);

    // Reschedule: move callbackAt to a new instant that is strictly AFTER the
    // last notification yet still in the past (so it is due again). Deriving it
    // from the stored notifiedAt keeps the ordering deterministic regardless of
    // how fast the test runs.
    const rescheduledAt = new Date(notifiedAt.getTime() + 1);
    await db
      .update(leadsTable)
      .set({ callbackAt: rescheduledAt })
      .where(eq(leadsTable.id, rfx.leadId));

    enqueueSpy.mockClear();
    emitSpy.mockClear();

    // Next sweep must fire exactly one fresh reminder for the rescheduled lead.
    await checkDueCallbacks();

    const refire = enqueueSpy.mock.calls
      .map((c) => (c[0] as { data: { leadId: number } }).data.leadId)
      .filter((id) => id === rfx.leadId);
    expect(
      refire.length,
      "a rescheduled (newly-due-again) callback must fire exactly one fresh reminder",
    ).toBe(1);

    const refireEmits = emitSpy.mock.calls
      .map((c) => (c[1] as { leadId: number }).leadId)
      .filter((id) => id === rfx.leadId);
    expect(refireEmits.length).toBe(1);

    // The DB row is now notified for the new callbackAt (notifiedAt advanced
    // past the rescheduled time).
    const [afterResched] = await db
      .select({
        callbackAt: leadsTable.callbackAt,
        callbackNotifiedAt: leadsTable.callbackNotifiedAt,
      })
      .from(leadsTable)
      .where(eq(leadsTable.id, rfx.leadId));
    expect(afterResched.callbackNotifiedAt).not.toBeNull();
    expect(afterResched.callbackAt).not.toBeNull();
    expect(
      (afterResched.callbackNotifiedAt as Date).getTime(),
      "after re-firing, notifiedAt must be >= the rescheduled callbackAt",
    ).toBeGreaterThanOrEqual((afterResched.callbackAt as Date).getTime());

    // And a follow-up sweep with no further change is once again a no-op.
    enqueueSpy.mockClear();
    await checkDueCallbacks();
    expect(
      enqueueSpy.mock.calls
        .map((c) => (c[0] as { data: { leadId: number } }).data.leadId)
        .filter((id) => id === rfx.leadId),
    ).toEqual([]);
  });
});

/**
 * Partial-overlap contract: the existing concurrency test starts both sweeps at
 * the same instant. This one covers the subtler case where one sweep is already
 * mid-flight — it has claimed SOME (but not all) due rows — when a second sweep
 * begins. We start sweep #1, poll the DB until it has notified at least one but
 * fewer than all of the seeded leads, and only THEN launch sweep #2. The
 * conditional claim UPDATE must still guarantee exactly one reminder per lead:
 * rows already claimed by sweep #1 are skipped by sweep #2, and rows sweep #1
 * has not yet reached are claimed by whichever sweep gets there first.
 */
const PARTIAL_DUE_COUNT = 200;

interface PartialFx {
  tenantId: number;
  csrId: number;
  dueIds: number[];
}

let pfx: PartialFx;

describe("checkDueCallbacks — partial-overlap sweeps (real Postgres)", () => {
  beforeAll(async () => {
    const slug = `cb-partial`;
    const [tenant] = await db
      .insert(tenantsTable)
      .values({ name: `Callback Partial Int ${slug}`, clientSlug: slug })
      .returning();
    const [csr] = await db
      .insert(usersTable)
      .values({
        email: `${slug}-csr@example.com`,
        name: "CSR",
        passwordHash: "x",
        role: "client_user",
        tenantId: tenant.id,
      })
      .returning();

    const past = (mins: number) => new Date(Date.now() - mins * 60 * 1000);

    // Enough rows (well over the page size of 50) that a single sweep takes many
    // per-row UPDATE round trips to finish — giving us a reliable window to
    // observe it mid-flight and start the second sweep while some rows are still
    // unclaimed. Shared callbackAt so both sweeps contend in the same order.
    const dueIds: number[] = [];
    for (let i = 0; i < PARTIAL_DUE_COUNT; i++) {
      const [lead] = await db
        .insert(leadsTable)
        .values({
          tenantId: tenant.id,
          firstName: "Partial",
          lastName: `Lead${i}`,
          source: "Meta",
          originalSource: "Meta",
          hubStatus: "day_1",
          assignedCsrId: csr.id,
          callbackAt: past(10),
          callbackNotifiedAt: null,
        })
        .returning({ id: leadsTable.id });
      dueIds.push(lead.id);
    }

    pfx = { tenantId: tenant.id, csrId: csr.id, dueIds };
  });

  afterAll(async () => {
    if (!pfx) return;
    try {
      await db.delete(leadsTable).where(eq(leadsTable.tenantId, pfx.tenantId));
      await db.delete(usersTable).where(eq(usersTable.id, pfx.csrId));
      await db.delete(tenantsTable).where(eq(tenantsTable.id, pfx.tenantId));
    } catch {
      /* best-effort cleanup */
    }
  });

  const notifiedCount = async (): Promise<number> => {
    const rows = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.tenantId, pfx.tenantId),
          isNotNull(leadsTable.callbackNotifiedAt),
        ),
      );
    return rows.length;
  };

  it("fires exactly one reminder per lead when a second sweep starts mid-first-sweep", async () => {
    enqueueSpy.mockClear();
    emitSpy.mockClear();

    // Kick off sweep #1 but do NOT await it yet — let it run on the event loop.
    const sweep1 = checkDueCallbacks();

    // Poll until sweep #1 has claimed SOME but not ALL rows, so sweep #2 truly
    // starts during a partial overlap. Guard with a max iteration count so a
    // pathologically fast (or stalled) sweep can't hang the test.
    let observedPartial = false;
    for (let i = 0; i < 500; i++) {
      const claimed = await notifiedCount();
      if (claimed > 0 && claimed < PARTIAL_DUE_COUNT) {
        observedPartial = true;
        break;
      }
      if (claimed >= PARTIAL_DUE_COUNT) break;
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(
      observedPartial,
      "expected to catch sweep #1 mid-flight (some but not all rows claimed)",
    ).toBe(true);

    // Now start sweep #2 while sweep #1 is still in progress, then let both finish.
    const sweep2 = checkDueCallbacks();
    await Promise.all([sweep1, sweep2]);

    // Every due lead is notified exactly once at the DB level.
    const rows = await db
      .select({
        id: leadsTable.id,
        callbackAt: leadsTable.callbackAt,
        callbackNotifiedAt: leadsTable.callbackNotifiedAt,
      })
      .from(leadsTable)
      .where(inArray(leadsTable.id, pfx.dueIds));

    expect(rows).toHaveLength(PARTIAL_DUE_COUNT);
    const unnotified = rows.filter(
      (r) =>
        r.callbackNotifiedAt === null ||
        (r.callbackAt !== null && r.callbackNotifiedAt < r.callbackAt),
    );
    expect(
      unnotified.map((r) => r.id),
      "every due callback must be notified — a partial overlap must not skip any",
    ).toEqual([]);

    // Exactly one push + one socket emit per due lead across BOTH sweeps.
    const notifiedDueLeadIds = enqueueSpy.mock.calls
      .map((c) => (c[0] as { data: { leadId: number } }).data.leadId)
      .filter((id) => pfx.dueIds.includes(id));
    expect(
      notifiedDueLeadIds.length,
      "total reminders must equal the number of due leads — extras mean a double-fire",
    ).toBe(PARTIAL_DUE_COUNT);
    expect(
      new Set(notifiedDueLeadIds).size,
      "each due lead must be reminded exactly once across the overlapping sweeps",
    ).toBe(PARTIAL_DUE_COUNT);

    const emittedDueLeadIds = emitSpy.mock.calls
      .map((c) => (c[1] as { leadId: number }).leadId)
      .filter((id) => pfx.dueIds.includes(id));
    expect(emittedDueLeadIds.length).toBe(PARTIAL_DUE_COUNT);
    expect(new Set(emittedDueLeadIds).size).toBe(PARTIAL_DUE_COUNT);
  });
});
