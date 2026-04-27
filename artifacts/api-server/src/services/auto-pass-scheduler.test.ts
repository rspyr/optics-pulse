import { describe, it, expect } from "vitest";
import {
  pickNextCsrForCascade,
  isStickyTerminalAtRest,
  isStickyTerminalOnTransition,
  isStickyActiveInOrder,
  evaluateStrandedRerouteEligibility,
} from "./auto-pass-scheduler";

const stickyConfig = {
  allowPassBack: true,
  stickyAfterCascade: true,
  stickyCsrId: 10,
};

const nonStickyConfig = {
  allowPassBack: true,
  stickyAfterCascade: false,
  stickyCsrId: null,
};

describe("isStickyActiveInOrder", () => {
  it("returns true when sticky CSR is in active order", () => {
    expect(isStickyActiveInOrder(stickyConfig, [10, 11, 12])).toBe(true);
  });

  it("returns false when sticky CSR is paused (not in active order)", () => {
    expect(isStickyActiveInOrder(stickyConfig, [11, 12])).toBe(false);
  });

  it("returns false when stickyCsrId is null", () => {
    expect(isStickyActiveInOrder(nonStickyConfig, [11, 12])).toBe(false);
  });
});

describe("isStickyTerminalAtRest", () => {
  it("returns true when assigned to active sticky CSR after full cycle", () => {
    expect(isStickyTerminalAtRest(stickyConfig, 10, 2, [10, 11, 12])).toBe(true);
  });

  it("returns false when sticky CSR is paused (not in active order)", () => {
    expect(isStickyTerminalAtRest(stickyConfig, 10, 2, [11, 12])).toBe(false);
  });

  it("returns false when not yet at end of cycle", () => {
    expect(isStickyTerminalAtRest(stickyConfig, 10, 1, [10, 11, 12])).toBe(false);
  });

  it("returns false when assigned CSR is not the sticky CSR", () => {
    expect(isStickyTerminalAtRest(stickyConfig, 11, 2, [10, 11, 12])).toBe(false);
  });

  it("returns false when sticky-after-cascade is disabled", () => {
    expect(isStickyTerminalAtRest(nonStickyConfig, 10, 2, [10, 11, 12])).toBe(false);
  });
});

describe("isStickyTerminalOnTransition", () => {
  it("returns terminal end_of_cycle when next is active sticky CSR at end", () => {
    const r = isStickyTerminalOnTransition(stickyConfig, 10, 2, 1, [10, 11, 12]);
    expect(r.terminal).toBe(true);
    expect(r.reason).toBe("end_of_cycle");
  });

  it("returns terminal rotation_arrival when next is active sticky CSR mid-cycle with prior passes", () => {
    const r = isStickyTerminalOnTransition(stickyConfig, 10, 1, 1, [10, 11, 12]);
    expect(r.terminal).toBe(true);
    expect(r.reason).toBe("rotation_arrival");
  });

  it("returns non-terminal when sticky CSR is paused (not in active order)", () => {
    const r = isStickyTerminalOnTransition(stickyConfig, 10, 2, 1, [11, 12]);
    expect(r.terminal).toBe(false);
  });
});

describe("pickNextCsrForCascade", () => {
  describe("baseline: sticky CSR active", () => {
    it("end-of-cycle redirects to sticky CSR", () => {
      const result = pickNextCsrForCascade({
        config: stickyConfig,
        assignedCsrId: 12,
        cascadePassCount: 2,
        activeOrder: [10, 11, 12],
      });
      expect(result).toEqual({
        action: "pass",
        nextCsrId: 10,
        viaSticky: true,
        rotationLandedOnSticky: false,
      });
    });

    it("mid-cycle rotation that lands on sticky CSR flags rotationLandedOnSticky", () => {
      const result = pickNextCsrForCascade({
        config: { allowPassBack: true, stickyAfterCascade: true, stickyCsrId: 11 },
        assignedCsrId: 10,
        cascadePassCount: 1,
        activeOrder: [10, 11, 12],
      });
      expect(result).toEqual({
        action: "pass",
        nextCsrId: 11,
        viaSticky: false,
        rotationLandedOnSticky: true,
      });
    });

    it("at active sticky CSR after full cycle returns terminal_at_sticky", () => {
      const result = pickNextCsrForCascade({
        config: stickyConfig,
        assignedCsrId: 10,
        cascadePassCount: 2,
        activeOrder: [10, 11, 12],
      });
      expect(result).toEqual({ action: "terminal_at_sticky" });
    });
  });

  describe("(a) sticky CSR paused at end of cycle", () => {
    it("does NOT redirect to sticky CSR; falls back to next-in-rotation", () => {
      const result = pickNextCsrForCascade({
        config: stickyConfig,
        assignedCsrId: 12,
        cascadePassCount: 2,
        activeOrder: [11, 12],
      });
      expect(result.action).toBe("pass");
      if (result.action !== "pass") return;
      expect(result.nextCsrId).toBe(11);
      expect(result.viaSticky).toBe(false);
      expect(result.rotationLandedOnSticky).toBe(false);
    });
  });

  describe("(b) sticky CSR paused mid-rotation", () => {
    it("does not 'stick' when rotation would have landed on sticky CSR", () => {
      const result = pickNextCsrForCascade({
        config: { allowPassBack: true, stickyAfterCascade: true, stickyCsrId: 11 },
        assignedCsrId: 10,
        cascadePassCount: 1,
        activeOrder: [10, 12],
      });
      expect(result.action).toBe("pass");
      if (result.action !== "pass") return;
      expect(result.nextCsrId).toBe(12);
      expect(result.viaSticky).toBe(false);
      expect(result.rotationLandedOnSticky).toBe(false);
    });
  });

  describe("(c) lead currently assigned to paused sticky CSR with cascadePassCount at end-of-cycle", () => {
    it("re-routes to first active CSR rather than returning terminal_at_sticky", () => {
      const result = pickNextCsrForCascade({
        config: stickyConfig,
        assignedCsrId: 10,
        cascadePassCount: 2,
        activeOrder: [11, 12],
      });
      expect(result.action).toBe("pass");
      if (result.action !== "pass") return;
      expect(result.nextCsrId).toBe(11);
      expect(result.viaSticky).toBe(false);
    });

    it("re-routes to first active CSR even mid-cycle when assigned to paused sticky", () => {
      const result = pickNextCsrForCascade({
        config: stickyConfig,
        assignedCsrId: 10,
        cascadePassCount: 1,
        activeOrder: [11, 12],
      });
      expect(result.action).toBe("pass");
      if (result.action !== "pass") return;
      expect(result.nextCsrId).toBe(11);
    });
  });

  describe("non-sticky configs unaffected", () => {
    it("normal pass-back rotation cycles through active order", () => {
      const result = pickNextCsrForCascade({
        config: { allowPassBack: true, stickyAfterCascade: false, stickyCsrId: null },
        assignedCsrId: 11,
        cascadePassCount: 0,
        activeOrder: [10, 11, 12],
      });
      expect(result.action).toBe("pass");
      if (result.action !== "pass") return;
      expect(result.nextCsrId).toBe(12);
    });

    it("no-pass-back returns no_next at end of order", () => {
      const result = pickNextCsrForCascade({
        config: { allowPassBack: false, stickyAfterCascade: false, stickyCsrId: null },
        assignedCsrId: 12,
        cascadePassCount: 0,
        activeOrder: [10, 11, 12],
      });
      expect(result).toEqual({ action: "no_next" });
    });

    it("no-pass-back advances to next CSR mid-order", () => {
      const result = pickNextCsrForCascade({
        config: { allowPassBack: false, stickyAfterCascade: false, stickyCsrId: null },
        assignedCsrId: 11,
        cascadePassCount: 0,
        activeOrder: [10, 11, 12],
      });
      expect(result.action).toBe("pass");
      if (result.action !== "pass") return;
      expect(result.nextCsrId).toBe(12);
    });
  });

  describe("Advantage production scenario: tenant 3, sticky=Corey(10) paused", () => {
    it("Manny(11) → Zeke(12) → next-active-CSR (NOT Corey)", () => {
      // Active order excludes paused Corey (10): [11, 12]
      // Lead at Zeke (12) after one prior pass; would have redirected to Corey
      const result = pickNextCsrForCascade({
        config: { allowPassBack: true, stickyAfterCascade: true, stickyCsrId: 10 },
        assignedCsrId: 12,
        cascadePassCount: 1,
        activeOrder: [11, 12],
      });
      expect(result.action).toBe("pass");
      if (result.action !== "pass") return;
      expect(result.nextCsrId).not.toBe(10);
      expect(result.nextCsrId).toBe(11);
      expect(result.viaSticky).toBe(false);
    });
  });
});

describe("evaluateStrandedRerouteEligibility (one-shot remediation)", () => {
  const now = new Date("2026-04-27T12:00:00Z");

  it("re-routes when sticky CSR is paused and excluded from active order", () => {
    const result = evaluateStrandedRerouteEligibility({
      config: { stickyAfterCascade: true, stickyCsrId: 10 },
      stickyPauseSchedule: { isPaused: true, pauseEnd: null },
      activeOrder: [11, 12],
      now,
    });
    expect(result).toEqual({ shouldReroute: true, targetCsrId: 11 });
  });

  it("re-routes when pause has a future end time", () => {
    const result = evaluateStrandedRerouteEligibility({
      config: { stickyAfterCascade: true, stickyCsrId: 10 },
      stickyPauseSchedule: { isPaused: true, pauseEnd: new Date("2026-04-27T18:00:00Z") },
      activeOrder: [11, 12],
      now,
    });
    expect(result).toEqual({ shouldReroute: true, targetCsrId: 11 });
  });

  it("does not re-route when sticky CSR is not configured", () => {
    const result = evaluateStrandedRerouteEligibility({
      config: { stickyAfterCascade: false, stickyCsrId: null },
      stickyPauseSchedule: { isPaused: true, pauseEnd: null },
      activeOrder: [11, 12],
      now,
    });
    expect(result).toEqual({ shouldReroute: false, reason: 'no_sticky_config' });
  });

  it("does not re-route when sticky CSR is not paused", () => {
    const result = evaluateStrandedRerouteEligibility({
      config: { stickyAfterCascade: true, stickyCsrId: 10 },
      stickyPauseSchedule: null,
      activeOrder: [10, 11, 12],
      now,
    });
    expect(result).toEqual({ shouldReroute: false, reason: 'sticky_not_paused' });
  });

  it("does not re-route when pause has already expired", () => {
    const result = evaluateStrandedRerouteEligibility({
      config: { stickyAfterCascade: true, stickyCsrId: 10 },
      stickyPauseSchedule: { isPaused: true, pauseEnd: new Date("2026-04-27T08:00:00Z") },
      activeOrder: [11, 12],
      now,
    });
    expect(result).toEqual({ shouldReroute: false, reason: 'pause_expired' });
  });

  it("does not re-route when no active CSRs exist (avoids losing the lead entirely)", () => {
    const result = evaluateStrandedRerouteEligibility({
      config: { stickyAfterCascade: true, stickyCsrId: 10 },
      stickyPauseSchedule: { isPaused: true, pauseEnd: null },
      activeOrder: [],
      now,
    });
    expect(result).toEqual({ shouldReroute: false, reason: 'no_active_csrs' });
  });

  it("does not re-route when sticky CSR is somehow still in active order (sanity guard)", () => {
    const result = evaluateStrandedRerouteEligibility({
      config: { stickyAfterCascade: true, stickyCsrId: 10 },
      stickyPauseSchedule: { isPaused: true, pauseEnd: null },
      activeOrder: [10, 11, 12],
      now,
    });
    expect(result).toEqual({ shouldReroute: false, reason: 'sticky_still_in_active_order' });
  });
});
