/**
 * Unit test for the clean-database safety check (`assertTestDbEmpty`).
 *
 * The integration suite provisions a per-run disposable DB and relies on it
 * starting completely empty so "exact count" assertions are trustworthy.
 * `assertTestDbEmpty` is the guard that enforces that — it counts the key
 * tables and refuses to run if any already has rows. The guard protects the
 * whole suite, so it must itself be tested: a future refactor that broke it
 * (wrong table names, a swallowed error, an inverted condition) would silently
 * remove the protection. These tests pin its contract against a tiny stub,
 * independent of vitest's globalSetup lifecycle.
 */
import { describe, it, expect, vi } from "vitest";
import {
  assertTestDbEmpty,
  KEY_TABLES,
  type CountQueryable,
} from "./global-setup";

/**
 * Build a stub queryable whose `count(*)` result per table comes from `counts`
 * (defaulting to 0). It parses the table name out of the `FROM "<table>"`
 * clause so the stub mirrors exactly which tables the check decides to query.
 */
function makeDb(counts: Record<string, number> = {}): {
  db: CountQueryable;
  queriedTables: string[];
} {
  const queriedTables: string[] = [];
  const db: CountQueryable = {
    query: vi.fn(async (sql: string) => {
      const match = sql.match(/FROM "([^"]+)"/);
      const table = match?.[1] ?? "";
      queriedTables.push(table);
      const count = counts[table] ?? 0;
      return { rows: [{ count: String(count) }] as never[] };
    }),
  };
  return { db, queriedTables };
}

describe("assertTestDbEmpty — clean-database safety check", () => {
  it("passes when every key table is empty", async () => {
    const { db } = makeDb();
    await expect(assertTestDbEmpty(db, "mos_test_x")).resolves.toBeUndefined();
  });

  it("queries exactly the key tables", async () => {
    const { db, queriedTables } = makeDb();
    await assertTestDbEmpty(db, "mos_test_x");
    expect(queriedTables.sort()).toEqual([...KEY_TABLES].sort());
  });

  it("throws when a key table has rows", async () => {
    const { db } = makeDb({ tenants: 3 });
    await expect(assertTestDbEmpty(db, "mos_test_x")).rejects.toThrow(
      /leftover rows/,
    );
  });

  it("names the dirty table and its row count in the error", async () => {
    const { db } = makeDb({ leads: 7 });
    await expect(assertTestDbEmpty(db, "mos_test_x")).rejects.toThrow(
      /leads=7/,
    );
  });

  it("reports every dirty table, not just the first", async () => {
    const { db } = makeDb({ jobs: 2, background_jobs: 5 });
    let error: Error | undefined;
    try {
      await assertTestDbEmpty(db, "mos_test_x");
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain("jobs=2");
    expect(error?.message).toContain("background_jobs=5");
  });

  it("includes the test DB name in the error for debuggability", async () => {
    const { db } = makeDb({ tenants: 1 });
    await expect(assertTestDbEmpty(db, "mos_test_deadbeef")).rejects.toThrow(
      /mos_test_deadbeef/,
    );
  });

  it("detects dirt in any key table individually", async () => {
    for (const table of KEY_TABLES) {
      const { db } = makeDb({ [table]: 1 });
      await expect(assertTestDbEmpty(db, "mos_test_x")).rejects.toThrow(
        new RegExp(`${table}=1`),
      );
    }
  });

  it("treats a missing count row as zero rather than crashing", async () => {
    const db: CountQueryable = {
      query: vi.fn(async () => ({ rows: [] as never[] })),
    };
    await expect(assertTestDbEmpty(db, "mos_test_x")).resolves.toBeUndefined();
  });

  it("honors an explicit table list", async () => {
    const { db, queriedTables } = makeDb({ widgets: 4 });
    await expect(
      assertTestDbEmpty(db, "mos_test_x", ["widgets"]),
    ).rejects.toThrow(/widgets=4/);
    expect(queriedTables).toEqual(["widgets"]);
  });
});
