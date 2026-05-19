import { describe, it, expect, vi, beforeEach } from "vitest";

const { emitRuleRederiveCompleteMock, emitRuleRederiveFailedMock, reDeriveLeadsForRuleScopeMock, countPendingRederiveLeadsForRuleScopeMock, registerJobHandlerMock } = vi.hoisted(() => ({
  emitRuleRederiveCompleteMock: vi.fn(),
  emitRuleRederiveFailedMock: vi.fn(),
  reDeriveLeadsForRuleScopeMock: vi.fn(),
  countPendingRederiveLeadsForRuleScopeMock: vi.fn(),
  registerJobHandlerMock: vi.fn(),
}));

vi.mock("../socket", () => ({
  emitRuleRederiveComplete: emitRuleRederiveCompleteMock,
  emitRuleRederiveFailed: emitRuleRederiveFailedMock,
}));

vi.mock("./re-derive-lead-funnel", () => ({
  reDeriveLeadsForRuleScope: reDeriveLeadsForRuleScopeMock,
  countPendingRederiveLeadsForRuleScope: countPendingRederiveLeadsForRuleScopeMock,
}));

vi.mock("./background-jobs", () => ({
  registerJobHandler: registerJobHandlerMock,
  enqueueJob: vi.fn(),
}));

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

const sleepCalls: number[] = [];

async function loadHandler(): Promise<Handler> {
  vi.resetModules();
  emitRuleRederiveCompleteMock.mockReset();
  emitRuleRederiveFailedMock.mockReset();
  reDeriveLeadsForRuleScopeMock.mockReset();
  countPendingRederiveLeadsForRuleScopeMock.mockReset();
  countPendingRederiveLeadsForRuleScopeMock.mockResolvedValue({
    pendingLeads: 7,
    hitLimit: false,
    maxLeads: 200,
    lastAttemptedAt: "2026-05-19T00:00:00.000Z",
  });
  registerJobHandlerMock.mockReset();
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
      { excludeLeadId: 77 },
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
