// Coverage for resolvePreset (the pure date math behind the Agency God View's
// date-range picker). The contract being defended:
//   1. Each preset returns a stable YYYY-MM-DD start/end computed from LOCAL
//      calendar fields — never UTC — so a user east/west of UTC sees the exact
//      day they picked, with no off-by-one shift.
//   2. "custom" passes the caller-supplied start/end straight through.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolvePreset } from "@/components/date-range-picker";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

describe("resolvePreset", () => {
  beforeEach(() => {
    // Pin "now" to a fixed local wall-clock instant so the math is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 15, 9, 30, 0)); // May 15, 2026, 09:30 local
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("thisMonth starts on the 1st of the current local month and ends today", () => {
    const { startDate, endDate } = resolvePreset("thisMonth");
    expect(startDate).toBe("2026-05-01");
    expect(endDate).toBe("2026-05-15");
    expect(startDate).toMatch(YMD);
    expect(endDate).toMatch(YMD);
  });

  it("lastMonth spans the full previous local month", () => {
    const { startDate, endDate } = resolvePreset("lastMonth");
    expect(startDate).toBe("2026-04-01");
    expect(endDate).toBe("2026-04-30");
  });

  it("last30 ends today and starts 30 days earlier", () => {
    const { startDate, endDate } = resolvePreset("last30");
    expect(endDate).toBe("2026-05-15");
    expect(startDate).toBe("2026-04-15");
  });

  it("custom passes through the supplied dates unchanged", () => {
    const { startDate, endDate } = resolvePreset("custom", {
      startDate: "2026-01-03",
      endDate: "2026-02-09",
    });
    expect(startDate).toBe("2026-01-03");
    expect(endDate).toBe("2026-02-09");
  });

  it("does not shift the day for a late-evening local time (no UTC drift)", () => {
    // 23:30 local on the 1st: a UTC-based serializer in a UTC+ zone would roll
    // this forward to the 2nd. Local serialization must keep it on the 1st.
    vi.setSystemTime(new Date(2026, 5, 1, 23, 30, 0)); // Jun 1, 2026, 23:30 local
    const { startDate, endDate } = resolvePreset("thisMonth");
    expect(startDate).toBe("2026-06-01");
    expect(endDate).toBe("2026-06-01");
  });
});
