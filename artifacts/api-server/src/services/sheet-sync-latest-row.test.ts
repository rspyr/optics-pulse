/**
 * Pure-function safety net for the appointment-date OSCILLATION fix.
 *
 * The oscillation bug was killed by making the rescan path collapse all
 * duplicate-phone rows to ONE deterministic "latest" submission per phone
 * (`buildLatestRowByPhone`) using an order-independent comparator (`rowIsLater`),
 * instead of comparing each row against a stale snapshot and writing on any
 * difference.
 *
 * The integration test (`sheet-sync-rescan-oscillation.integration.test.ts`)
 * proves the *fixed* end-to-end behavior, but it would still pass if someone
 * quietly made the picker non-deterministic in a way the fixture happened not to
 * trip. This file locks the picker itself:
 *
 *   - `rowIsLater` is a total, deterministic ordering (timestamp first, sheet
 *     index as the ONLY tie-breaker, parseable always beats unparseable).
 *   - `buildLatestRowByPhone` chooses the same winner regardless of the order
 *     the rows arrive in, collapses phone-format variants to one key, and never
 *     lets an unparseable-timestamp row outrank a parseable one.
 *
 * If the comparator or the dedupe-by-phone collapse is changed in a way that
 * reintroduces order-dependence / non-determinism, these tests fail.
 *
 * @workspace/db is mocked so this stays a pure unit test (no Postgres). The real
 * `normalizePhone` is used on purpose — phone-key collapse is part of the
 * contract under test.
 */
import { describe, it, expect, vi } from "vitest";

// Only the DB needs stubbing; everything else (incl. the real normalizePhone)
// loads normally. A Proxy hands back a unique symbol for every table import so
// we never have to enumerate them.
vi.mock("@workspace/db", () => {
  const tableCache = new Map<string, symbol>();
  const stub = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "db") return {};
        if (prop === "__esModule") return true;
        if (!tableCache.has(prop)) tableCache.set(prop, Symbol(prop));
        return tableCache.get(prop);
      },
    },
  );
  return stub as Record<string, unknown>;
});

const { rowIsLater, buildLatestRowByPhone } = await import("./sheet-sync");
type OrderedRow = Parameters<typeof rowIsLater>[0];
type MappedRow = Parameters<typeof buildLatestRowByPhone>[0][number];

function mk(fields: { phone: string; dateTime?: string; appointmentDate?: string }): MappedRow {
  return {
    firstName: "",
    lastName: "",
    phone: fields.phone,
    email: "",
    source: "",
    serviceType: "",
    dateTime: fields.dateTime ?? "",
    appointmentDate: fields.appointmentDate ?? "",
  } as MappedRow;
}

function ord(ms: number | null, index: number): OrderedRow {
  return { row: mk({ phone: "5550000000" }), index, ms };
}

/** Every distinct ordering of `items` (small arrays only). */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) out.push([item, ...perm]);
  });
  return out;
}

describe("rowIsLater — deterministic submission ordering", () => {
  it("orders by timestamp when both rows have one", () => {
    const earlier = ord(1000, 0);
    const later = ord(2000, 1);
    expect(rowIsLater(later, earlier)).toBe(true);
    expect(rowIsLater(earlier, later)).toBe(false);
  });

  it("is antisymmetric: a>b and b>a cannot both be true", () => {
    const a = ord(2000, 5);
    const b = ord(1000, 9);
    expect(rowIsLater(a, b)).toBe(true);
    expect(rowIsLater(b, a)).toBe(false);
  });

  it("a parseable timestamp always outranks a missing/unparseable one", () => {
    const parseable = ord(1000, 0);
    const unparseable = ord(null, 99); // higher index must NOT rescue it
    expect(rowIsLater(parseable, unparseable)).toBe(true);
    expect(rowIsLater(unparseable, parseable)).toBe(false);
  });

  it("breaks equal-timestamp ties by sheet index only (never randomly)", () => {
    const sameMsLowIdx = ord(5000, 2);
    const sameMsHighIdx = ord(5000, 7);
    expect(rowIsLater(sameMsHighIdx, sameMsLowIdx)).toBe(true);
    expect(rowIsLater(sameMsLowIdx, sameMsHighIdx)).toBe(false);
  });

  it("falls back to sheet index when neither row has a timestamp", () => {
    const lowIdx = ord(null, 1);
    const highIdx = ord(null, 4);
    expect(rowIsLater(highIdx, lowIdx)).toBe(true);
    expect(rowIsLater(lowIdx, highIdx)).toBe(false);
  });

  it("equal timestamp AND equal index is not 'later' than itself (strict order)", () => {
    const a = ord(5000, 3);
    const b = ord(5000, 3);
    expect(rowIsLater(a, b)).toBe(false);
    expect(rowIsLater(b, a)).toBe(false);
  });
});

describe("buildLatestRowByPhone — order-independent latest-wins per phone", () => {
  const PHONE = "5558000001";
  // Four submissions for one phone, with one UNPARSEABLE timestamp. The latest
  // PARSEABLE submission (2026-06-01 → appt 2026-06-15) must always win.
  const baseRows = [
    mk({ phone: PHONE, dateTime: "2026-05-01T09:00:00", appointmentDate: "2026-05-15" }),
    mk({ phone: PHONE, dateTime: "2026-06-01T09:00:00", appointmentDate: "2026-06-15" }),
    mk({ phone: PHONE, dateTime: "not-a-real-date", appointmentDate: "2026-07-01" }),
    mk({ phone: PHONE, dateTime: "2026-05-10T09:00:00", appointmentDate: "2026-05-25" }),
  ];
  const WINNER_APPT = "2026-06-15";

  it("picks the latest parseable submission as the winner", () => {
    const latest = buildLatestRowByPhone(baseRows);
    expect(latest.size).toBe(1);
    expect(latest.get(PHONE)?.row.appointmentDate).toBe(WINNER_APPT);
  });

  it("chooses the SAME winner for every input ordering (no oscillation)", () => {
    const winners = new Set<string | undefined>();
    for (const perm of permutations(baseRows)) {
      winners.add(buildLatestRowByPhone(perm).get(PHONE)?.row.appointmentDate);
    }
    // One and only one winner across all 24 permutations.
    expect([...winners]).toEqual([WINNER_APPT]);
  });

  it("never lets an unparseable-timestamp row win, in any ordering", () => {
    for (const perm of permutations(baseRows)) {
      const chosen = buildLatestRowByPhone(perm).get(PHONE)?.row.appointmentDate;
      expect(chosen).not.toBe("2026-07-01");
    }
  });

  it("collapses phone-format variants of the same number into one entry", () => {
    const rows = [
      mk({ phone: "(555) 800-0001", dateTime: "2026-05-01T09:00:00", appointmentDate: "2026-05-15" }),
      mk({ phone: "1-555-800-0001", dateTime: "2026-06-01T09:00:00", appointmentDate: "2026-06-15" }),
      mk({ phone: "5558000001", dateTime: "2026-04-01T09:00:00", appointmentDate: "2026-04-15" }),
    ];
    const latest = buildLatestRowByPhone(rows);
    expect(latest.size).toBe(1);
    expect(latest.get("5558000001")?.row.appointmentDate).toBe("2026-06-15");
  });

  it("skips rows whose phone normalizes to empty", () => {
    const rows = [
      mk({ phone: "", dateTime: "2026-06-01T09:00:00", appointmentDate: "2026-06-15" }),
      mk({ phone: "   ", dateTime: "2026-06-02T09:00:00", appointmentDate: "2026-06-16" }),
      mk({ phone: PHONE, dateTime: "2026-06-03T09:00:00", appointmentDate: "2026-06-17" }),
    ];
    const latest = buildLatestRowByPhone(rows);
    expect(latest.size).toBe(1);
    expect(latest.get(PHONE)?.row.appointmentDate).toBe("2026-06-17");
  });

  it("when no row has a parseable timestamp, the last sheet row wins deterministically", () => {
    const rows = [
      mk({ phone: PHONE, dateTime: "", appointmentDate: "2026-08-01" }),
      mk({ phone: PHONE, dateTime: "garbage", appointmentDate: "2026-08-02" }),
      mk({ phone: PHONE, dateTime: "", appointmentDate: "2026-08-03" }),
    ];
    const latest = buildLatestRowByPhone(rows);
    expect(latest.get(PHONE)?.row.appointmentDate).toBe("2026-08-03");
  });

  it("keeps distinct phones separate, each resolved to its own latest", () => {
    const rows = [
      mk({ phone: "5558000001", dateTime: "2026-05-01T09:00:00", appointmentDate: "2026-05-15" }),
      mk({ phone: "5558000002", dateTime: "2026-05-01T09:00:00", appointmentDate: "2026-09-09" }),
      mk({ phone: "5558000001", dateTime: "2026-06-01T09:00:00", appointmentDate: "2026-06-15" }),
      mk({ phone: "5558000002", dateTime: "2026-04-01T09:00:00", appointmentDate: "2026-04-04" }),
    ];
    const latest = buildLatestRowByPhone(rows);
    expect(latest.size).toBe(2);
    expect(latest.get("5558000001")?.row.appointmentDate).toBe("2026-06-15");
    expect(latest.get("5558000002")?.row.appointmentDate).toBe("2026-09-09");
  });
});
