import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  emitRuleRederiveCompleteMock,
  emitRuleRederiveFailedMock,
  emitSelectedLeadsRederiveCancelledMock,
  emitSelectedLeadsRederiveCompleteMock,
  emitSelectedLeadsRederiveFailedMock,
  emitSelectedLeadsRederiveProgressMock,
  reDeriveLeadsForRuleScopeMock,
  reDeriveLeadFunnelMock,
  countPendingRederiveLeadsForRuleScopeMock,
  registerJobHandlerMock,
  isJobCancelledMock,
} = vi.hoisted(() => ({
  emitRuleRederiveCompleteMock: vi.fn(),
  emitRuleRederiveFailedMock: vi.fn(),
  emitSelectedLeadsRederiveCancelledMock: vi.fn(),
  emitSelectedLeadsRederiveCompleteMock: vi.fn(),
  emitSelectedLeadsRederiveFailedMock: vi.fn(),
  emitSelectedLeadsRederiveProgressMock: vi.fn(),
  reDeriveLeadsForRuleScopeMock: vi.fn(),
  reDeriveLeadFunnelMock: vi.fn(),
  countPendingRederiveLeadsForRuleScopeMock: vi.fn(),
  registerJobHandlerMock: vi.fn(),
  isJobCancelledMock: vi.fn(),
}));

vi.mock("../socket", () => ({
  emitRuleRederiveComplete: emitRuleRederiveCompleteMock,
  emitRuleRederiveFailed: emitRuleRederiveFailedMock,
  emitSelectedLeadsRederiveCancelled: emitSelectedLeadsRederiveCancelledMock,
  emitSelectedLeadsRederiveComplete: emitSelectedLeadsRederiveCompleteMock,
  emitSelectedLeadsRederiveFailed: emitSelectedLeadsRederiveFailedMock,
  emitSelectedLeadsRederiveProgress: emitSelectedLeadsRederiveProgressMock,
}));

vi.mock("./re-derive-lead-funnel", () => ({
  reDeriveLeadsForRuleScope: reDeriveLeadsForRuleScopeMock,
  reDeriveLeadFunnel: reDeriveLeadFunnelMock,
  countPendingRederiveLeadsForRuleScope: countPendingRederiveLeadsForRuleScopeMock,
}));

vi.mock("./background-jobs", () => ({
  registerJobHandler: registerJobHandlerMock,
  enqueueJob: vi.fn(),
  isJobCancelled: isJobCancelledMock,
}));

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

const sleepCalls: number[] = [];

async function loadHandler(): Promise<Handler> {
  vi.resetModules();
  emitRuleRederiveCompleteMock.mockReset();
  emitRuleRederiveFailedMock.mockReset();
  emitSelectedLeadsRederiveCancelledMock.mockReset();
  emitSelectedLeadsRederiveCompleteMock.mockReset();
  emitSelectedLeadsRederiveFailedMock.mockReset();
  emitSelectedLeadsRederiveProgressMock.mockReset();
  reDeriveLeadsForRuleScopeMock.mockReset();
  reDeriveLeadFunnelMock.mockReset();
  countPendingRederiveLeadsForRuleScopeMock.mockReset();
  countPendingRederiveLeadsForRuleScopeMock.mockResolvedValue({
    pendingLeads: 7,
    hitLimit: false,
    maxLeads: 200,
    lastAttemptedAt: "2026-05-19T00:00:00.000Z",
  });
  registerJobHandlerMock.mockReset();
  isJobCancelledMock.mockReset();
  isJobCancelledMock.mockResolvedValue(false);
  sleepCalls.length = 0;

  const mod = await import("./re-derive-jobs");
  mod.__setSleepForTests(async (ms: number) => {
    sleepCalls.push(ms);
  });
  mod.registerReDeriveJobHandlers();
  const call = registerJobHandlerMock.mock.calls.find(
    (c: unknown[]) => c[0] === "rederive_leads_for_rule_scope",
  );
  expect(call).toBeDefined();
  return call![1] as Handler;
}

type HandlerWithCtx = (
  payload: Record<string, unknown>,
  ctx?: { job?: { id: number } },
) => Promise<unknown>;

async function loadSelectedHandler(): Promise<HandlerWithCtx> {
  // loadHandler resets all mocks and re-registers all job handlers
  await loadHandler();
  const call = registerJobHandlerMock.mock.calls.find(
    (c: unknown[]) => c[0] === "rederive_selected_leads",
  );
  expect(call).toBeDefined();
  return call![1] as HandlerWithCtx;
}

describe("re-derive-jobs handler — emits rule-rederive-complete after fan-out finishes", () => {
  beforeEach(() => {
    emitRuleRederiveCompleteMock.mockReset();
    emitRuleRederiveFailedMock.mockReset();
    reDeriveLeadsForRuleScopeMock.mockReset();
  });

  it("emits rule-rederive-complete on the tenant socket room once fan-out resolves, with the scope + result payload", async () => {
    const handler = await loadHandler();
    reDeriveLeadsForRuleScopeMock.mockResolvedValue({ leadsChanged: 12, hitLimit: true, maxLeads: 500 });

    const result = await handler({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "ac-breakdown-prevention",
      excludeLeadId: 77,
    });

    expect(reDeriveLeadsForRuleScopeMock).toHaveBeenCalledTimes(1);
    expect(reDeriveLeadsForRuleScopeMock).toHaveBeenCalledWith(
      42,
      "/contact",
      "ac-breakdown-prevention",
      // Task #584: ruleId is now threaded through so the per-event
      // `manual` flips can stamp `field_mapping_rule:<id>`. Legacy
      // payloads without ruleId default to null.
      { excludeLeadId: 77, ruleId: null },
    );

    expect(emitRuleRederiveCompleteMock).toHaveBeenCalledTimes(1);
    expect(emitRuleRederiveCompleteMock).toHaveBeenCalledWith(42, {
      pageUrlPattern: "/contact",
      formIdentifier: "ac-breakdown-prevention",
      leadsChanged: 12,
      hitLimit: true,
      maxLeads: 500,
    });
    expect(result).toEqual({ leadsChanged: 12, hitLimit: true, maxLeads: 500 });
  });

  it("still emits rule-rederive-complete when zero leads were changed so the panel clears its 'working…' state", async () => {
    const handler = await loadHandler();
    reDeriveLeadsForRuleScopeMock.mockResolvedValue({ leadsChanged: 0, hitLimit: false, maxLeads: 500 });

    await handler({
      tenantId: 42,
      pageUrlPattern: "/quote",
      formIdentifier: "quote-form",
      excludeLeadId: null,
    });

    expect(emitRuleRederiveCompleteMock).toHaveBeenCalledTimes(1);
    expect(emitRuleRederiveCompleteMock).toHaveBeenCalledWith(42, {
      pageUrlPattern: "/quote",
      formIdentifier: "quote-form",
      leadsChanged: 0,
      hitLimit: false,
      maxLeads: 500,
    });
  });

  it("does not emit rule-rederive-complete when the fan-out throws repeatedly — the error propagates so the job is marked failed/retryable, AND emits rule-rederive-failed so the panel can show the retry hint", async () => {
    const handler = await loadHandler();
    reDeriveLeadsForRuleScopeMock.mockRejectedValue(new Error("db blew up"));

    await expect(
      handler({
        tenantId: 42,
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form",
        excludeLeadId: null,
      }),
    ).rejects.toThrow("db blew up");

    // 1 initial + 2 retries = 3 total attempts before giving up
    expect(reDeriveLeadsForRuleScopeMock).toHaveBeenCalledTimes(3);
    expect(emitRuleRederiveCompleteMock).not.toHaveBeenCalled();
    expect(emitRuleRederiveFailedMock).toHaveBeenCalledTimes(1);
    expect(emitRuleRederiveFailedMock).toHaveBeenCalledWith(42, {
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      reason: "db blew up",
      pendingLeads: 7,
      hitLimit: false,
      maxLeads: 200,
      lastAttemptedAt: "2026-05-19T00:00:00.000Z",
    });
    // Pending-count query should be scoped to the same tenant/page/form
    // and pass excludeLeadId so the displayed count matches the fan-out's
    // selection semantics.
    expect(countPendingRederiveLeadsForRuleScopeMock).toHaveBeenCalledWith(
      42,
      "/contact",
      "contact-form",
      { excludeLeadId: null },
    );
  });

  it("auto-retries a transient failure and emits rule-rederive-complete (not -failed) when a later attempt succeeds", async () => {
    const handler = await loadHandler();
    reDeriveLeadsForRuleScopeMock
      .mockRejectedValueOnce(new Error("transient blip"))
      .mockResolvedValueOnce({ leadsChanged: 4, hitLimit: false, maxLeads: 500 });

    const result = await handler({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      excludeLeadId: null,
    });

    expect(reDeriveLeadsForRuleScopeMock).toHaveBeenCalledTimes(2);
    expect(emitRuleRederiveFailedMock).not.toHaveBeenCalled();
    expect(emitRuleRederiveCompleteMock).toHaveBeenCalledTimes(1);
    expect(emitRuleRederiveCompleteMock).toHaveBeenCalledWith(42, {
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      leadsChanged: 4,
      hitLimit: false,
      maxLeads: 500,
    });
    expect(result).toEqual({ leadsChanged: 4, hitLimit: false, maxLeads: 500 });
    // Backoff was actually waited (one backoff between attempt 1 -> 2)
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBeGreaterThan(0);
  });

  it("only emits rule-rederive-failed after the final attempt, not after each interim retry", async () => {
    const handler = await loadHandler();
    reDeriveLeadsForRuleScopeMock.mockRejectedValue(new Error("still broken"));

    await expect(
      handler({
        tenantId: 7,
        pageUrlPattern: "/p",
        formIdentifier: "f",
        excludeLeadId: null,
      }),
    ).rejects.toThrow("still broken");

    expect(reDeriveLeadsForRuleScopeMock).toHaveBeenCalledTimes(3);
    // Exactly one failed emit — not one per attempt
    expect(emitRuleRederiveFailedMock).toHaveBeenCalledTimes(1);
    // Backoff slept between each retry pair (after attempts 1 and 2, none after final)
    expect(sleepCalls).toHaveLength(2);
    // Exponential: second backoff is larger than the first
    expect(sleepCalls[1]).toBeGreaterThan(sleepCalls[0]);
  });

  it("swallows a socket-emit failure on the failed event so notification glitches don't mask the original error", async () => {
    const handler = await loadHandler();
    reDeriveLeadsForRuleScopeMock.mockRejectedValue(new Error("fan-out exploded"));
    emitRuleRederiveFailedMock.mockImplementationOnce(() => { throw new Error("socket down"); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      handler({
        tenantId: 42,
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form",
        excludeLeadId: null,
      }),
    ).rejects.toThrow("fan-out exploded");

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("rejects malformed payloads before invoking the fan-out (so a bad job row doesn't silently no-op)", async () => {
    const handler = await loadHandler();

    await expect(
      handler({ tenantId: "not-a-number", pageUrlPattern: "/x", formIdentifier: "y" } as unknown as Record<string, unknown>),
    ).rejects.toThrow(/Invalid payload/);

    expect(reDeriveLeadsForRuleScopeMock).not.toHaveBeenCalled();
    expect(emitRuleRederiveCompleteMock).not.toHaveBeenCalled();
  });

  it("fails fast on a non-retryable fan-out error (bad inputs / missing tenant) — no retries, no backoff sleeps, surfaces rule-rederive-failed immediately", async () => {
    const handler = await loadHandler();
    const nonRetryable = new Error("invalid pageUrlPattern \"\"");
    nonRetryable.name = "NonRetryableReDeriveError";
    reDeriveLeadsForRuleScopeMock.mockRejectedValue(nonRetryable);

    await expect(
      handler({
        tenantId: 42,
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form",
        excludeLeadId: null,
      }),
    ).rejects.toThrow(/invalid pageUrlPattern/);

    // Only the initial attempt — non-retryable errors short-circuit the loop
    expect(reDeriveLeadsForRuleScopeMock).toHaveBeenCalledTimes(1);
    // No backoff sleep burned on a known-permanent failure
    expect(sleepCalls).toHaveLength(0);
    // Operator still gets the failure event so the panel can clear and show retry hint
    expect(emitRuleRederiveFailedMock).toHaveBeenCalledTimes(1);
    expect(emitRuleRederiveFailedMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form",
        reason: "invalid pageUrlPattern \"\"",
      }),
    );
    expect(emitRuleRederiveCompleteMock).not.toHaveBeenCalled();
  });

  it("still retries when the fan-out throws a plain (transient-looking) Error — non-retryable classification must not over-catch", async () => {
    const handler = await loadHandler();
    reDeriveLeadsForRuleScopeMock.mockRejectedValue(new Error("connection reset"));

    await expect(
      handler({
        tenantId: 42,
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form",
        excludeLeadId: null,
      }),
    ).rejects.toThrow("connection reset");

    // 1 initial + 2 retries
    expect(reDeriveLeadsForRuleScopeMock).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toHaveLength(2);
  });

  it("swallows a socket-emit failure so a downstream notification glitch doesn't fail the job", async () => {
    const handler = await loadHandler();
    reDeriveLeadsForRuleScopeMock.mockResolvedValue({ leadsChanged: 3, hitLimit: false, maxLeads: 500 });
    emitRuleRederiveCompleteMock.mockImplementationOnce(() => {
      throw new Error("socket down");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handler({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form",
      excludeLeadId: null,
    });

    expect(result).toEqual({ leadsChanged: 3, hitLimit: false, maxLeads: 500 });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("re-derive-jobs selected-leads handler — cancel flow", () => {
  it("short-circuits the loop on mid-run cancel, emits cancelled with partial counts, and does NOT emit complete", async () => {
    const handler = await loadSelectedHandler();
    // 5 leads in payload; cancel flips to true before iteration #3 (i.e. after
    // 2 leads have been processed).
    let calls = 0;
    isJobCancelledMock.mockImplementation(async () => {
      calls++;
      return calls > 2;
    });
    reDeriveLeadFunnelMock.mockResolvedValue({ changed: true });

    const result = await handler(
      { tenantId: 42, leadIds: [1, 2, 3, 4, 5] },
      { job: { id: 999 } },
    );

    // Only the 2 leads processed before the cancel checkpoint flipped
    expect(reDeriveLeadFunnelMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      total: 5,
      processed: 2,
      succeeded: 2,
      failed: 0,
      changed: 2,
      failedLeadIds: [],
      // The tail of leads the cancel checkpoint never reached — drives the
      // sheet's "Re-derive the rest" affordance.
      skippedLeadIds: [3, 4, 5],
      cancelled: true,
    });

    // Cancelled event fires with the partial counts so the sheet can render
    // "Cancelled at 2/5 leads" instead of waiting on a timeout. We assert
    // with objectContaining so optional fields (scope, etc.) can be added
    // to the contract without churning every cancel-flow test.
    expect(emitSelectedLeadsRederiveCancelledMock).toHaveBeenCalledTimes(1);
    expect(emitSelectedLeadsRederiveCancelledMock).toHaveBeenCalledWith(42, expect.objectContaining({
      jobId: 999,
      total: 5,
      processed: 2,
      succeeded: 2,
      failed: 0,
      changed: 2,
      failedLeadIds: [],
      skippedLeadIds: [3, 4, 5],
    }));

    // The terminal `complete` and `failed` events must NOT fire for a cancel —
    // the row is in a `cancelled` terminal state already.
    expect(emitSelectedLeadsRederiveCompleteMock).not.toHaveBeenCalled();
    expect(emitSelectedLeadsRederiveFailedMock).not.toHaveBeenCalled();
  });

  it("cancel before the first lead returns 0/N partial counts and includes no successes", async () => {
    const handler = await loadSelectedHandler();
    isJobCancelledMock.mockResolvedValue(true);
    reDeriveLeadFunnelMock.mockResolvedValue({ changed: true });

    const result = await handler(
      { tenantId: 42, leadIds: [10, 20, 30] },
      { job: { id: 7 } },
    );

    expect(reDeriveLeadFunnelMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      total: 3,
      processed: 0,
      succeeded: 0,
      failed: 0,
      changed: 0,
      failedLeadIds: [],
      // Whole payload is skipped when the cancel fires before any iteration.
      skippedLeadIds: [10, 20, 30],
      cancelled: true,
    });
    expect(emitSelectedLeadsRederiveCancelledMock).toHaveBeenCalledWith(42, expect.objectContaining({
      jobId: 7,
      total: 3,
      processed: 0,
      succeeded: 0,
    }));
    expect(emitSelectedLeadsRederiveCompleteMock).not.toHaveBeenCalled();
  });

  it("when no jobId is in ctx, the cancel checkpoint is skipped and the loop runs to completion (sync path)", async () => {
    const handler = await loadSelectedHandler();
    // Even if isJobCancelled would return true, it shouldn't be consulted
    // when there's no jobId — there's no row to cancel.
    isJobCancelledMock.mockResolvedValue(true);
    reDeriveLeadFunnelMock.mockResolvedValue({ changed: false });

    const result = await handler({ tenantId: 42, leadIds: [1, 2] });

    expect(isJobCancelledMock).not.toHaveBeenCalled();
    expect(reDeriveLeadFunnelMock).toHaveBeenCalledTimes(2);
    expect(emitSelectedLeadsRederiveCancelledMock).not.toHaveBeenCalled();
    expect(emitSelectedLeadsRederiveCompleteMock).toHaveBeenCalledTimes(1);
    expect((result as { cancelled?: boolean }).cancelled).toBeUndefined();
  });

  it("a transient failure of the isJobCancelled check is swallowed (logged) and the loop keeps going", async () => {
    const handler = await loadSelectedHandler();
    isJobCancelledMock.mockRejectedValueOnce(new Error("db blip")).mockResolvedValue(false);
    reDeriveLeadFunnelMock.mockResolvedValue({ changed: false });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handler(
      { tenantId: 42, leadIds: [1, 2] },
      { job: { id: 5 } },
    );

    expect(reDeriveLeadFunnelMock).toHaveBeenCalledTimes(2);
    expect((result as { cancelled?: boolean }).cancelled).toBeUndefined();
    expect(emitSelectedLeadsRederiveCancelledMock).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("a socket-emit failure on the cancelled event is logged but does not turn the job into a thrown failure", async () => {
    const handler = await loadSelectedHandler();
    isJobCancelledMock.mockResolvedValue(true);
    emitSelectedLeadsRederiveCancelledMock.mockImplementationOnce(() => {
      throw new Error("socket down");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handler(
      { tenantId: 42, leadIds: [1] },
      { job: { id: 8 } },
    );

    expect((result as { cancelled?: boolean }).cancelled).toBe(true);
    // We do NOT fall through to emitting `complete` after a cancel, even when
    // the cancelled emit itself errors — the row is in a terminal cancelled
    // state and the sheet's timeout will recover.
    expect(emitSelectedLeadsRederiveCompleteMock).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
