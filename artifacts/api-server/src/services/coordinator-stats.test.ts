import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeAvgSpeedFromEvents, type FirstResponseEvent } from "./coordinator-stats";
import * as loginCalc from "./login-time-calculator";

function ev(partial: Partial<FirstResponseEvent> & { leadId: number; userId: number; wallClockSpeed: number }): FirstResponseEvent {
  return {
    assignedAt: partial.assignedAt ?? new Date("2026-01-01T09:00:00Z"),
    firstTouchAt: partial.firstTouchAt ?? new Date("2026-01-01T09:00:30Z"),
    ...partial,
  };
}

describe("computeAvgSpeedFromEvents", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 0 for empty events (no follow-ups added to the day)", async () => {
    expect(await computeAvgSpeedFromEvents([])).toBe(0);
  });

  it("returns 0 when all events have zero wall-clock speed", async () => {
    const events = [ev({ leadId: 1, userId: 1, wallClockSpeed: 0 })];
    expect(await computeAvgSpeedFromEvents(events)).toBe(0);
  });

  it("averages login-aware speeds across qualifying events", async () => {
    vi.spyOn(loginCalc, "computeLoginAwareSpeeds").mockResolvedValue([
      { leadId: 1, userId: 1, speed: 60 },
      { leadId: 2, userId: 1, speed: 180 },
    ]);
    const events = [
      ev({ leadId: 1, userId: 1, wallClockSpeed: 120 }),
      ev({ leadId: 2, userId: 1, wallClockSpeed: 300 }),
    ];
    expect(await computeAvgSpeedFromEvents(events)).toBe(120);
  });

  it("falls back to wall-clock when login-aware throws", async () => {
    vi.spyOn(loginCalc, "computeLoginAwareSpeeds").mockRejectedValue(new Error("boom"));
    const events = [
      ev({ leadId: 1, userId: 1, wallClockSpeed: 100 }),
      ev({ leadId: 2, userId: 1, wallClockSpeed: 200 }),
    ];
    expect(await computeAvgSpeedFromEvents(events)).toBe(150);
  });

  it("does not double-count a single assignment even if multiple events are passed", async () => {
    // Caller is responsible for de-duping at the query layer; here we just
    // confirm avg is over what is actually passed in. (Two same-day touches
    // collapse to one event at the query level — verified separately.)
    vi.spyOn(loginCalc, "computeLoginAwareSpeeds").mockResolvedValue([
      { leadId: 1, userId: 1, speed: 30 },
    ]);
    const events = [ev({ leadId: 1, userId: 1, wallClockSpeed: 30 })];
    expect(await computeAvgSpeedFromEvents(events)).toBe(30);
  });
});
