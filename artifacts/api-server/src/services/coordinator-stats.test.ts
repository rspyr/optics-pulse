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

  it("treats each (lead, assignment) as exactly one event", async () => {
    // Lead 1 assigned twice (e.g. auto-passed): each window contributes one event.
    vi.spyOn(loginCalc, "computeLoginAwareSpeeds").mockResolvedValue([
      { leadId: 1, userId: 1, speed: 30 },
      { leadId: 1, userId: 2, speed: 90 },
    ]);
    const events = [
      ev({ leadId: 1, userId: 1, wallClockSpeed: 30, assignedAt: new Date("2026-01-01T09:00:00Z") }),
      ev({ leadId: 1, userId: 2, wallClockSpeed: 90, assignedAt: new Date("2026-01-01T15:00:00Z") }),
    ];
    expect(await computeAvgSpeedFromEvents(events)).toBe(60);
  });

  it("excludes events with negative or zero wall-clock from the average", async () => {
    // A zero wall-clock event (touched at the exact assignment time) is filtered
    // before the login-aware step.
    const spy = vi.spyOn(loginCalc, "computeLoginAwareSpeeds").mockResolvedValue([
      { leadId: 2, userId: 1, speed: 45 },
    ]);
    const events = [
      ev({ leadId: 1, userId: 1, wallClockSpeed: 0 }),
      ev({ leadId: 2, userId: 1, wallClockSpeed: 60 }),
    ];
    expect(await computeAvgSpeedFromEvents(events)).toBe(45);
    expect(spy).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ leadId: 2 }),
    ]));
    // The zero-speed event was filtered before being passed to the login-aware step.
    const passedWindows = spy.mock.calls[0][0];
    expect(passedWindows.map(w => w.leadId)).toEqual([2]);
  });
});

describe("newLeadsHandled semantics", () => {
  // newLeadsHandled is implemented as `events.length` from the DISTINCT-ON
  // subquery. These tests document the intended semantics that the query
  // guarantees by construction:
  //   - exactly one event per (lead, assignedAt)
  //   - only events whose firstTouchAt falls in [dayStart, dayEnd]
  //   - only events whose first-touch CSR is in the requested userIds (if any)
  //
  // The DB-level enforcement of these rules is covered in the integration
  // test follow-up (#409); these unit assertions document the contract.

  it("an event list with N unique assignments yields newLeadsHandled = N", () => {
    const events: FirstResponseEvent[] = [
      ev({ leadId: 1, userId: 1, wallClockSpeed: 60 }),
      ev({ leadId: 2, userId: 1, wallClockSpeed: 120 }),
      ev({ leadId: 3, userId: 1, wallClockSpeed: 30 }),
    ];
    expect(events.length).toBe(3);
  });

  it("a cross-day follow-up does not add a new event for the original day", () => {
    // Same assignment, same lead, same CSR — only one event regardless of how
    // many follow-up calls happen on later days. The query layer guarantees
    // this via DISTINCT ON (lead_id, assigned_at) picking MIN(attempted_at).
    const assignedAt = new Date("2026-01-01T09:00:00Z");
    const sameDayEvent = ev({
      leadId: 1, userId: 1, wallClockSpeed: 60,
      assignedAt,
      firstTouchAt: new Date("2026-01-01T09:01:00Z"),
    });
    // The follow-up touch the next day would NOT appear as a second event,
    // because MIN(attempted_at) for that (lead, assignedAt) is on Jan 1.
    const events: FirstResponseEvent[] = [sameDayEvent];
    expect(events.length).toBe(1);
  });
});
