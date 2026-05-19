import { describe, it, expect } from "vitest";
import { backoffMs, decideRetryOrFail } from "./background-jobs";

describe("backoffMs", () => {
  it("returns increasing delays for successive attempts", () => {
    expect(backoffMs(1)).toBe(10_000);
    expect(backoffMs(2)).toBe(30_000);
    expect(backoffMs(3)).toBe(90_000);
    expect(backoffMs(4)).toBe(270_000);
  });

  it("caps at 30 minutes", () => {
    expect(backoffMs(20)).toBe(30 * 60 * 1000);
  });

  it("clamps zero/negative attempts to the base delay", () => {
    expect(backoffMs(0)).toBe(10_000);
    expect(backoffMs(-5)).toBe(10_000);
  });
});

describe("decideRetryOrFail", () => {
  const now = Date.UTC(2024, 0, 1, 0, 0, 0);

  it("schedules a retry when attempts < maxAttempts", () => {
    const result = decideRetryOrFail(1, 3, now);
    expect(result.outcome).toBe("retry");
    if (result.outcome !== "retry") throw new Error("unreachable");
    expect(result.nextRunAt.getTime()).toBe(now + 10_000);
  });

  it("uses exponential backoff across attempts", () => {
    const r1 = decideRetryOrFail(1, 5, now);
    const r2 = decideRetryOrFail(2, 5, now);
    const r3 = decideRetryOrFail(3, 5, now);
    if (r1.outcome !== "retry" || r2.outcome !== "retry" || r3.outcome !== "retry") {
      throw new Error("expected retry");
    }
    expect(r1.nextRunAt.getTime()).toBe(now + 10_000);
    expect(r2.nextRunAt.getTime()).toBe(now + 30_000);
    expect(r3.nextRunAt.getTime()).toBe(now + 90_000);
  });

  it("returns failed exactly when attempts reaches maxAttempts", () => {
    expect(decideRetryOrFail(2, 3, now).outcome).toBe("retry");
    expect(decideRetryOrFail(3, 3, now).outcome).toBe("failed");
    expect(decideRetryOrFail(4, 3, now).outcome).toBe("failed");
  });

  it("treats maxAttempts of 1 as one-shot (no retries)", () => {
    // attempts is incremented at claim, so by the time we decide the failure
    // path, attempts is already 1 on the first try. That should fail.
    expect(decideRetryOrFail(1, 1, now).outcome).toBe("failed");
  });
});
