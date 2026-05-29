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
import { eq, inArray } from "drizzle-orm";

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

  const slug = `cb-sweep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
