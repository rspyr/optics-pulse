/**
 * Real-Postgres integration test for `pruneOldTrackerAttempts`, which the
 * daily tracker-retention cron uses to enforce the 30-day audit window.
 *
 * Seeds a mix of old and recent tracker_submit_attempts rows on a fixture
 * tenant + domain, runs the prune, and asserts that rows older than the
 * retention window are deleted while rows inside the window are kept.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

const dbModule = await import("@workspace/db");
const { db, tenantsTable, trackerSubmitAttemptsTable } = dbModule;
const { pruneOldTrackerAttempts } = await import("./tracker-audit");

interface Fixtures {
  tenantId: number;
  domain: string;
  oldIds: number[];
  recentIds: number[];
}

let fx: Fixtures;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const slug = `tracker-retention-int-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const domain = `${slug}.example.com`;

  const [tenant] = await db.insert(tenantsTable).values({
    name: `Tracker Retention ${slug}`, clientSlug: slug,
  }).returning();

  const now = Date.now();
  const daysAgo = (d: number) => new Date(now - d * 24 * 60 * 60 * 1000);

  // Old rows — comfortably past a 30-day window.
  const old = await db.insert(trackerSubmitAttemptsTable).values([
    { tenantId: tenant.id, endpoint: "submit", kind: "submit", domain, outcome: "accepted", httpStatus: 200, createdAt: daysAgo(31) },
    { tenantId: tenant.id, endpoint: "submit", kind: "submit", domain, outcome: "server_error", httpStatus: 500, createdAt: daysAgo(60) },
    { tenantId: tenant.id, endpoint: "heartbeat", kind: "heartbeat", domain, outcome: "accepted", httpStatus: 200, createdAt: daysAgo(45) },
  ]).returning({ id: trackerSubmitAttemptsTable.id });

  // Recent rows — inside the 30-day window, must be preserved.
  const recent = await db.insert(trackerSubmitAttemptsTable).values([
    { tenantId: tenant.id, endpoint: "submit", kind: "submit", domain, outcome: "accepted", httpStatus: 200, createdAt: daysAgo(1) },
    { tenantId: tenant.id, endpoint: "submit", kind: "submit", domain, outcome: "rate_limited", httpStatus: 429, createdAt: daysAgo(15) },
    { tenantId: tenant.id, endpoint: "heartbeat", kind: "heartbeat", domain, outcome: "accepted", httpStatus: 200, createdAt: daysAgo(29) },
  ]).returning({ id: trackerSubmitAttemptsTable.id });

  fx = {
    tenantId: tenant.id,
    domain,
    oldIds: old.map(r => r.id),
    recentIds: recent.map(r => r.id),
  };
});

afterAll(async () => {
  if (!fx) return;
  try {
    await db.delete(trackerSubmitAttemptsTable)
      .where(inArray(trackerSubmitAttemptsTable.id, [...fx.oldIds, ...fx.recentIds]));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("pruneOldTrackerAttempts (real Postgres)", () => {
  it("deletes rows older than the retention window and keeps newer rows", async () => {
    const deleted = await pruneOldTrackerAttempts(30);

    // The sweep is global, so other dev rows older than 30d may also be
    // pruned. We only assert on our own fixture's rows.
    expect(deleted).toBeGreaterThanOrEqual(fx.oldIds.length);

    const survivingOld = await db
      .select({ id: trackerSubmitAttemptsTable.id })
      .from(trackerSubmitAttemptsTable)
      .where(inArray(trackerSubmitAttemptsTable.id, fx.oldIds));
    expect(survivingOld).toEqual([]);

    const survivingRecent = await db
      .select({ id: trackerSubmitAttemptsTable.id })
      .from(trackerSubmitAttemptsTable)
      .where(inArray(trackerSubmitAttemptsTable.id, fx.recentIds));
    expect(survivingRecent.map(r => r.id).sort()).toEqual([...fx.recentIds].sort());
  });

  it("custom retentionDays keeps rows within the larger window", async () => {
    // Re-seed a single old-but-recently-kept row at 10 days ago, and verify a
    // 7-day retention prunes it while a 30-day retention does not.
    const [row] = await db.insert(trackerSubmitAttemptsTable).values({
      tenantId: fx.tenantId,
      endpoint: "submit",
      kind: "submit",
      domain: fx.domain,
      outcome: "accepted",
      httpStatus: 200,
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    }).returning({ id: trackerSubmitAttemptsTable.id });

    await pruneOldTrackerAttempts(30);
    const afterLong = await db
      .select({ id: trackerSubmitAttemptsTable.id })
      .from(trackerSubmitAttemptsTable)
      .where(eq(trackerSubmitAttemptsTable.id, row.id));
    expect(afterLong).toHaveLength(1);

    await pruneOldTrackerAttempts(7);
    const afterShort = await db
      .select({ id: trackerSubmitAttemptsTable.id })
      .from(trackerSubmitAttemptsTable)
      .where(eq(trackerSubmitAttemptsTable.id, row.id));
    expect(afterShort).toEqual([]);
  });
});
