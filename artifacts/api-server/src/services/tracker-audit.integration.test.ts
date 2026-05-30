/**
 * Real-Postgres integration test for the tracker domain-health rollup and
 * per-domain submit breakdown.
 *
 * Both `getDomainHealthRollup` and `getDomainSubmitBreakdown` filter rows by
 * a list of tenant ids. They previously shared a silent-500 SQL bug in how
 * the IN-list was constructed; this suite seeds tracker_submit_attempts rows
 * across three tenants and calls each function with a multi-element
 * `tenantIds` array so a future regression in the IN-list shape can't slip
 * back in unnoticed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray, eq } from "drizzle-orm";

const dbModule = await import("@workspace/db");
const { db, tenantsTable, trackerSubmitAttemptsTable } = dbModule;
const { getDomainHealthRollup, getDomainSubmitBreakdown } = await import("./tracker-audit");

interface Fixtures {
  tenantA: number;
  tenantB: number;
  tenantC: number;
  domain: string;
  attemptIds: number[];
}

let fx: Fixtures;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const slug = `tracker-rollup-int`;
  const domain = `${slug}.example.com`;

  const [tA] = await db.insert(tenantsTable).values({
    name: `Tracker Rollup A ${slug}`, clientSlug: `${slug}-a`,
  }).returning();
  const [tB] = await db.insert(tenantsTable).values({
    name: `Tracker Rollup B ${slug}`, clientSlug: `${slug}-b`,
  }).returning();
  const [tC] = await db.insert(tenantsTable).values({
    name: `Tracker Rollup C ${slug}`, clientSlug: `${slug}-c`,
  }).returning();

  const now = Date.now();
  const minutesAgo = (m: number) => new Date(now - m * 60 * 1000);

  // Seed a mix of submit + heartbeat rows across three tenants, all on the
  // same unique domain so the rollup/breakdown queries scope cleanly to the
  // fixture without other dev data interfering.
  const inserted = await db.insert(trackerSubmitAttemptsTable).values([
    // Tenant A — 2 submits (one 200, one 500) and 1 heartbeat.
    { tenantId: tA.id, endpoint: "submit", kind: "submit", domain, outcome: "accepted", httpStatus: 200, createdAt: minutesAgo(60) },
    { tenantId: tA.id, endpoint: "submit", kind: "submit", domain, outcome: "server_error", httpStatus: 500, createdAt: minutesAgo(50) },
    { tenantId: tA.id, endpoint: "heartbeat", kind: "heartbeat", domain, outcome: "accepted", httpStatus: 200, pulseVersion: "1.2.3", createdAt: minutesAgo(40) },

    // Tenant B — 1 submit (429 rate-limited) and 1 heartbeat (no pulse_version).
    { tenantId: tB.id, endpoint: "submit", kind: "submit", domain, outcome: "rate_limited", httpStatus: 429, createdAt: minutesAgo(30) },
    { tenantId: tB.id, endpoint: "heartbeat", kind: "heartbeat", domain, outcome: "accepted", httpStatus: 200, createdAt: minutesAgo(25) },

    // Tenant C — 2 submits (one 200, one 404). Must NOT appear when the
    // caller scopes to [A, B] only.
    { tenantId: tC.id, endpoint: "submit", kind: "submit", domain, outcome: "accepted", httpStatus: 200, createdAt: minutesAgo(20) },
    { tenantId: tC.id, endpoint: "submit", kind: "submit", domain, outcome: "invalid_payload", httpStatus: 404, createdAt: minutesAgo(15) },
  ]).returning({ id: trackerSubmitAttemptsTable.id });

  fx = {
    tenantA: tA.id,
    tenantB: tB.id,
    tenantC: tC.id,
    domain,
    attemptIds: inserted.map(r => r.id),
  };
});

afterAll(async () => {
  if (!fx) return;
  try {
    await db.delete(trackerSubmitAttemptsTable).where(inArray(trackerSubmitAttemptsTable.id, fx.attemptIds));
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, [fx.tenantA, fx.tenantB, fx.tenantC]));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("getDomainHealthRollup with multi-tenant filter (real Postgres)", () => {
  it("returns rows for every in-scope tenant on the seeded domain", async () => {
    const rows = await getDomainHealthRollup({ tenantIds: [fx.tenantA, fx.tenantB] });
    const ours = rows.filter(r => r.domain === fx.domain);

    const byTenant = Object.fromEntries(ours.map(r => [r.tenantId, r]));
    expect(Object.keys(byTenant).sort()).toEqual([String(fx.tenantA), String(fx.tenantB)].sort());

    // Tenant A: 2 submits in 24h (one 200, one 500); heartbeat had pulse_version.
    expect(byTenant[fx.tenantA].submitCount24h).toBe(2);
    expect(byTenant[fx.tenantA].statusBuckets24h.s200).toBe(1);
    expect(byTenant[fx.tenantA].statusBuckets24h.s500).toBe(1);
    expect(byTenant[fx.tenantA].scriptSource).toBe("pulse");
    expect(byTenant[fx.tenantA].lastPulseVersion).toBe("1.2.3");

    // Tenant B: 1 submit (429); heartbeat with no pulse_version → "unknown".
    expect(byTenant[fx.tenantB].submitCount24h).toBe(1);
    expect(byTenant[fx.tenantB].statusBuckets24h.s429).toBe(1);
    expect(byTenant[fx.tenantB].scriptSource).toBe("unknown");
    expect(byTenant[fx.tenantB].lastPulseVersion).toBeNull();
  });

  it("excludes tenants outside the filter list", async () => {
    const rows = await getDomainHealthRollup({ tenantIds: [fx.tenantA, fx.tenantB] });
    const ours = rows.filter(r => r.domain === fx.domain);
    expect(ours.some(r => r.tenantId === fx.tenantC)).toBe(false);
  });

  it("returns an empty array for an empty tenantIds filter", async () => {
    const rows = await getDomainHealthRollup({ tenantIds: [] });
    expect(rows).toEqual([]);
  });
});

describe("getDomainSubmitBreakdown with multi-tenant filter (real Postgres)", () => {
  it("sums submit rows across multiple in-scope tenants and excludes others", async () => {
    const breakdown = await getDomainSubmitBreakdown({
      domain: fx.domain,
      windowHours: 24,
      tenantIds: [fx.tenantA, fx.tenantB],
    });

    // A: 1×200 + 1×500. B: 1×429. C (not in filter): 1×200 + 1×404 → ignored.
    expect(breakdown.total).toBe(3);
    expect(breakdown.submitOk).toBe(1);
    expect(breakdown.submitServerError).toBe(1);
    expect(breakdown.submitRateLimited).toBe(1);
    expect(breakdown.submitClientError).toBe(0);
  });

  it("scoping to a single tenant returns just that tenant's submits", async () => {
    const onlyA = await getDomainSubmitBreakdown({
      domain: fx.domain,
      windowHours: 24,
      tenantIds: [fx.tenantA],
    });
    expect(onlyA.total).toBe(2);
    expect(onlyA.submitOk).toBe(1);
    expect(onlyA.submitServerError).toBe(1);
  });

  it("empty tenantIds returns the zeroed breakdown", async () => {
    const empty = await getDomainSubmitBreakdown({
      domain: fx.domain,
      windowHours: 24,
      tenantIds: [],
    });
    expect(empty).toEqual({
      submitOk: 0, submitClientError: 0, submitRateLimited: 0, submitServerError: 0, total: 0,
    });
  });
});
