import { describe, it, expect, vi, beforeEach } from "vitest";

const { emitRuleRederiveCompleteMock, reDeriveLeadsForRuleScopeMock, registerJobHandlerMock } = vi.hoisted(() => ({
  emitRuleRederiveCompleteMock: vi.fn(),
  reDeriveLeadsForRuleScopeMock: vi.fn(),
  registerJobHandlerMock: vi.fn(),
}));

vi.mock("../socket", () => ({
  emitRuleRederiveComplete: emitRuleRederiveCompleteMock,
}));

vi.mock("./re-derive-lead-funnel", () => ({
  reDeriveLeadsForRuleScope: reDeriveLeadsForRuleScopeMock,
}));

vi.mock("./background-jobs", () => ({
  registerJobHandler: registerJobHandlerMock,
  enqueueJob: vi.fn(),
}));

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
  vi.resetModules();
  emitRuleRederiveCompleteMock.mockReset();
  reDeriveLeadsForRuleScopeMock.mockReset();
  registerJobHandlerMock.mockReset();

  const mod = await import("./re-derive-jobs");
  mod.registerReDeriveJobHandlers();
  expect(registerJobHandlerMock).toHaveBeenCalledTimes(1);
  expect(registerJobHandlerMock.mock.calls[0][0]).toBe("rederive_leads_for_rule_scope");
  return registerJobHandlerMock.mock.calls[0][1] as Handler;
}

describe("re-derive-jobs handler — emits rule-rederive-complete after fan-out finishes", () => {
  beforeEach(() => {
    emitRuleRederiveCompleteMock.mockReset();
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

  it("does not emit rule-rederive-complete when the fan-out throws — the error propagates so the job is marked failed/retryable", async () => {
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

    expect(emitRuleRederiveCompleteMock).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads before invoking the fan-out (so a bad job row doesn't silently no-op)", async () => {
    const handler = await loadHandler();

    await expect(
      handler({ tenantId: "not-a-number", pageUrlPattern: "/x", formIdentifier: "y" } as unknown as Record<string, unknown>),
    ).rejects.toThrow(/Invalid payload/);

    expect(reDeriveLeadsForRuleScopeMock).not.toHaveBeenCalled();
    expect(emitRuleRederiveCompleteMock).not.toHaveBeenCalled();
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
