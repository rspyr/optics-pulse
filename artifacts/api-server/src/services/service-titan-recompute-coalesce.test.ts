// Guards the per-tenant advisory lock that coalesces concurrent ServiceTitan
// revenue recomputes into a single run (the 0x53545256 = "STRV" lock added in
// the rebate-recompute work).
//
// Saving the rebate-program list several times in quick succession — or saving
// while a manual recompute is already in flight — used to fire multiple
// uncoordinated full re-syncs, doubling ServiceTitan API load and racing on the
// same invoice/estimate/job row updates. `recomputeServiceTitanRevenue` now
// takes a `pg_try_advisory_lock` first: the first caller runs the full re-sync,
// any overlapping caller gets `{ alreadyRunning: true }` and is a no-op.
//
// We mock `@workspace/db` so the advisory lock has real mutex semantics (a
// Set of held lock keys) and gate the first tenant lookup with a deferred
// promise. That lets us hold the lock open across a genuinely concurrent second
// call and assert the second call coalesces instead of stacking a duplicate
// re-sync. No Postgres required.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Advisory-lock + select gating state ─────────────────────────────────────

const lockState = {
  held: new Set<string>(),
  reset() {
    this.held.clear();
  },
};

// A deferred used to suspend the first tenant lookup inside
// syncServiceTitanInvoices so the first recompute keeps holding the advisory
// lock while the second (concurrent) recompute attempts to acquire it.
let selectGate: Promise<void> | null = null;
let releaseSelectGate: (() => void) | null = null;
function armSelectGate() {
  selectGate = new Promise<void>((resolve) => {
    releaseSelectGate = resolve;
  });
}
function disarmSelectGate() {
  selectGate = null;
  releaseSelectGate = null;
}

vi.mock("@workspace/db", () => {
  const tablecol = (t: string) => new Proxy({}, { get: (_: unknown, k: string) => `${t}.${String(k)}` });

  async function resolveSelect(): Promise<unknown[]> {
    if (selectGate) await selectGate;
    // Return no tenant: syncServiceTitanInvoices/Estimates short-circuit with
    // "Tenant not found" after the first lookup, so the recompute body stays
    // tiny while still exercising the real lock acquire/release path.
    return [];
  }

  function makeSelectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const terminal = {
      then: (r: Function, j?: Function) =>
        resolveSelect().then(r as (v: unknown) => unknown, j as (e: unknown) => unknown),
      limit: vi.fn().mockImplementation(() => ({
        then: (r: Function, j?: Function) =>
          resolveSelect().then(r as (v: unknown) => unknown, j as (e: unknown) => unknown),
      })),
      orderBy: vi.fn().mockImplementation(() => ({
        limit: vi.fn().mockImplementation(() => ({
          then: (r: Function, j?: Function) =>
            resolveSelect().then(r as (v: unknown) => unknown, j as (e: unknown) => unknown),
        })),
        then: (r: Function, j?: Function) =>
          resolveSelect().then(r as (v: unknown) => unknown, j as (e: unknown) => unknown),
      })),
    };
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(terminal);
    chain.orderBy = terminal.orderBy;
    chain.limit = terminal.limit;
    chain.then = terminal.then;
    return chain;
  }

  const db = {
    select: vi.fn().mockImplementation(() => makeSelectChain()),
    // The advisory lock lives entirely in db.execute. We give it real mutex
    // semantics keyed by (lockKey:tenantId) so try_advisory_lock returns
    // got=false whenever the same lock is already held.
    execute: vi.fn().mockImplementation((q: { __strings?: string[]; __values?: unknown[] }) => {
      const text = (q?.__strings ?? []).join(" ");
      const values = q?.__values ?? [];
      const key = `${String(values[0])}:${String(values[1])}`;
      if (text.includes("pg_try_advisory_lock")) {
        if (lockState.held.has(key)) return Promise.resolve({ rows: [{ got: false }] });
        lockState.held.add(key);
        return Promise.resolve({ rows: [{ got: true }] });
      }
      if (text.includes("pg_advisory_unlock")) {
        lockState.held.delete(key);
        return Promise.resolve({ rows: [{ unlocked: true }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  };

  return {
    db,
    pool: {},
    tenantsTable: tablecol("tenants"),
    jobsTable: tablecol("jobs"),
    leadsTable: tablecol("leads"),
    campaignsTable: tablecol("campaigns"),
    campaignDailyStatsTable: tablecol("campaign_daily_stats"),
    integrationSyncLogsTable: tablecol("integration_sync_logs"),
    soldEstimatesTable: tablecol("sold_estimates"),
    callAttemptsTable: tablecol("call_attempts"),
    metaAdsTable: tablecol("meta_ads"),
    metaAdSetsTable: tablecol("meta_ad_sets"),
    metaAdDailyStatsTable: tablecol("meta_ad_daily_stats"),
  };
});

vi.mock("drizzle-orm", () => {
  const passthrough = (op: string) => (...args: unknown[]) => ({ __op: op, args });
  const sqlTag = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      __strings: Array.from(strings),
      __values: values,
    }),
    { raw: (s: string) => ({ __strings: [s], __values: [] }), join: passthrough("join") },
  );
  return {
    eq: passthrough("eq"),
    and: passthrough("and"),
    or: passthrough("or"),
    isNull: passthrough("isNull"),
    isNotNull: passthrough("isNotNull"),
    desc: passthrough("desc"),
    sql: sqlTag,
  };
});

// Notifications are fired on error paths; stub them so nothing hits the network.
vi.mock("./notifications", () => ({
  emitSyncFailureNotification: vi.fn().mockResolvedValue(undefined),
  emitSyncCatchupNotification: vi.fn().mockResolvedValue(undefined),
}));

const { recomputeServiceTitanRevenue } = await import("./sync-scheduler");

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  lockState.reset();
  disarmSelectGate();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recomputeServiceTitanRevenue — per-tenant advisory lock coalescing", () => {
  it("coalesces two concurrent recomputes for the same tenant into one run; the second returns { alreadyRunning: true }", async () => {
    armSelectGate();

    // Call A acquires the lock and then suspends on the gated tenant lookup,
    // keeping the lock held.
    const aPromise = recomputeServiceTitanRevenue(42);
    await tick(); // let A acquire the lock and reach the gated select

    // Lock is held → B must coalesce without running its own re-sync.
    const bResult = await recomputeServiceTitanRevenue(42);
    expect(bResult.alreadyRunning).toBe(true);
    expect(bResult.invoices.synced).toBe(0);
    expect(bResult.estimates.error).toBe("skipped");

    // Let A finish and release the lock.
    releaseSelectGate!();
    const aResult = await aPromise;
    expect(aResult.alreadyRunning).toBeFalsy();

    // Lock fully released afterwards.
    expect(lockState.held.size).toBe(0);
  });

  it("does NOT coalesce recomputes for different tenants (distinct lock keys run in parallel)", async () => {
    armSelectGate();

    const aPromise = recomputeServiceTitanRevenue(1);
    await tick();

    // A different tenant uses a different (key:tenantId) lock, so it is NOT
    // blocked by tenant 1's in-flight recompute.
    const bPromise = recomputeServiceTitanRevenue(2);
    await tick();

    releaseSelectGate!();
    const [a, b] = await Promise.all([aPromise, bPromise]);
    expect(a.alreadyRunning).toBeFalsy();
    expect(b.alreadyRunning).toBeFalsy();
    expect(lockState.held.size).toBe(0);
  });

  it("releases the lock after a run so a later recompute can acquire it again", async () => {
    const first = await recomputeServiceTitanRevenue(7);
    expect(first.alreadyRunning).toBeFalsy();
    expect(lockState.held.size).toBe(0);

    const second = await recomputeServiceTitanRevenue(7);
    expect(second.alreadyRunning).toBeFalsy();
    expect(lockState.held.size).toBe(0);
  });
});
