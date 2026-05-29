/**
 * Unit test for the callback-scheduler re-entrancy guard (`runGuardedSweep`).
 *
 * The scheduler fires `checkDueCallbacks` on a fixed interval, but a sweep can
 * outlast that interval. Without a guard, each tick would launch another
 * overlapping sweep and the redundant runs would pile up. `runGuardedSweep`
 * ensures at most one sweep runs at a time: a tick that fires while a sweep is
 * still in progress is dropped. These tests pin that contract.
 *
 * `@workspace/db`, the push enqueue, and the socket emit are mocked so this is a
 * pure logic test that never touches real infrastructure.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("@workspace/db", () => ({ db: {}, leadsTable: {} }));
vi.mock("./push-notification-jobs", () => ({ enqueueSendPushToUser: vi.fn() }));
vi.mock("../socket", () => ({ emitCallbackDue: vi.fn() }));

const { runGuardedSweep } = await import("./callback-scheduler");

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("runGuardedSweep — re-entrancy guard", () => {
  it("skips a tick while the previous sweep is still running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowSweep = vi.fn(async () => {
      await gate;
    });

    // First tick starts the sweep and parks on the gate.
    const first = runGuardedSweep(slowSweep);
    // Second tick fires while the first is still in flight — it must be dropped.
    const second = await runGuardedSweep(slowSweep);

    expect(second).toBe(false);
    expect(slowSweep).toHaveBeenCalledTimes(1);

    // Let the first sweep finish; it reports that it ran.
    release();
    expect(await first).toBe(true);

    // Once the in-flight sweep completes, the guard is cleared and a later tick
    // runs normally again.
    const third = await runGuardedSweep(slowSweep);
    expect(third).toBe(true);
    expect(slowSweep).toHaveBeenCalledTimes(2);
  });

  it("clears the guard even if a sweep throws", async () => {
    const boom = vi.fn(async () => {
      throw new Error("sweep failed");
    });

    await expect(runGuardedSweep(boom)).rejects.toThrow("sweep failed");

    // The guard must be released after a failure so the next tick is not
    // permanently blocked.
    const ok = vi.fn(async () => {});
    const ran = await runGuardedSweep(ok);
    expect(ran).toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
