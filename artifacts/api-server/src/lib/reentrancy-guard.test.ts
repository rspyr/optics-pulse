/**
 * Unit test for the shared re-entrancy guard (`createGuardedRunner`).
 *
 * Periodic schedulers fire a sweep on a fixed interval, but a single sweep can
 * outlast that interval. Without a guard, each tick launches another overlapping
 * sweep and the redundant runs pile up. `createGuardedRunner` wraps a sweep so
 * at most one runs at a time: a tick that fires while a sweep is still in
 * progress is dropped. These tests pin that contract — the same guarantee every
 * scheduler now relies on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createGuardedRunner } from "./reentrancy-guard";

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("createGuardedRunner — re-entrancy guard", () => {
  it("skips a tick while the previous sweep is still running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowSweep = vi.fn(async () => {
      await gate;
    });
    const run = createGuardedRunner("Test");

    // First tick starts the sweep and parks on the gate.
    const first = run(slowSweep);
    // Second tick fires while the first is still in flight — it must be dropped.
    const second = await run(slowSweep);

    expect(second).toBe(false);
    expect(slowSweep).toHaveBeenCalledTimes(1);

    // Let the first sweep finish; it reports that it ran.
    release();
    expect(await first).toBe(true);

    // Once the in-flight sweep completes, the guard is cleared and a later tick
    // runs normally again.
    const third = await run(slowSweep);
    expect(third).toBe(true);
    expect(slowSweep).toHaveBeenCalledTimes(2);
  });

  it("clears the guard even if a sweep throws", async () => {
    const run = createGuardedRunner("Test");
    const boom = vi.fn(async () => {
      throw new Error("sweep failed");
    });

    await expect(run(boom)).rejects.toThrow("sweep failed");

    // The guard must be released after a failure so the next tick is not
    // permanently blocked.
    const ok = vi.fn(async () => {});
    const ran = await run(ok);
    expect(ran).toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("uses the configured default sweep when called with no argument", async () => {
    const defaultSweep = vi.fn(async () => {});
    const run = createGuardedRunner("Test", defaultSweep);

    const ran = await run();

    expect(ran).toBe(true);
    expect(defaultSweep).toHaveBeenCalledTimes(1);
  });

  it("isolates separate runners — one in-flight sweep does not block another", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runA = createGuardedRunner("A");
    const runB = createGuardedRunner("B");

    const slowA = vi.fn(async () => {
      await gate;
    });
    const quickB = vi.fn(async () => {});

    // A is parked in-flight; B must still be allowed to run.
    const aPromise = runA(slowA);
    const bRan = await runB(quickB);

    expect(bRan).toBe(true);
    expect(quickB).toHaveBeenCalledTimes(1);

    release();
    expect(await aPromise).toBe(true);
  });

  it("throws when invoked with no sweep and no default", async () => {
    const run = createGuardedRunner("Test");
    await expect(run()).rejects.toThrow(/no default sweep/i);
  });
});
