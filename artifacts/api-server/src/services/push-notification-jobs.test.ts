import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  sendPushToUserMock,
  sendPushToTenantUsersMock,
  registerJobHandlerMock,
} = vi.hoisted(() => ({
  sendPushToUserMock: vi.fn(),
  sendPushToTenantUsersMock: vi.fn(),
  registerJobHandlerMock: vi.fn(),
}));

vi.mock("./push-notifications", () => ({
  sendPushToUser: sendPushToUserMock,
  sendPushToTenantUsers: sendPushToTenantUsersMock,
}));

vi.mock("./background-jobs", () => ({
  registerJobHandler: registerJobHandlerMock,
  enqueueJob: vi.fn(),
}));

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

const OK_REPORT = {
  attempted: 1,
  succeeded: 1,
  permanentFailures: 0,
  transientFailures: 0,
  topLevelError: null,
};

async function loadHandler(): Promise<Handler> {
  vi.resetModules();
  sendPushToUserMock.mockReset();
  sendPushToTenantUsersMock.mockReset();
  registerJobHandlerMock.mockReset();

  const mod = await import("./push-notification-jobs");
  mod.registerPushNotificationJobHandlers();
  expect(registerJobHandlerMock).toHaveBeenCalledTimes(1);
  expect(registerJobHandlerMock.mock.calls[0][0]).toBe("send_push_notification");
  return registerJobHandlerMock.mock.calls[0][1] as Handler;
}

describe("push-notification-jobs handler", () => {
  beforeEach(() => {
    sendPushToUserMock.mockReset();
    sendPushToTenantUsersMock.mockReset();
  });

  it("drops stale pushes (age > PUSH_MAX_AGE_MS) without calling the sender", async () => {
    const { PUSH_MAX_AGE_MS } = await import("./push-notification-jobs");
    const handler = await loadHandler();

    const now = Date.now();
    const staleEnqueuedAt = now - (PUSH_MAX_AGE_MS + 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await handler({
      target: { kind: "user", userId: 7 },
      title: "Hi",
      body: "There",
      enqueuedAt: staleEnqueuedAt,
      source: "test-stale",
    });

    expect(result).toMatchObject({ skipped: true, reason: "stale" });
    expect(sendPushToUserMock).not.toHaveBeenCalled();
    expect(sendPushToTenantUsersMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("routes { kind: 'user' } payloads through sendPushToUser", async () => {
    const handler = await loadHandler();
    sendPushToUserMock.mockResolvedValue(OK_REPORT);

    const data = { leadId: 123 };
    await handler({
      target: { kind: "user", userId: 42 },
      title: "New lead",
      body: "Acme Co",
      data,
      enqueuedAt: Date.now(),
      source: "lead-notify",
    });

    expect(sendPushToUserMock).toHaveBeenCalledTimes(1);
    expect(sendPushToUserMock).toHaveBeenCalledWith(42, "New lead", "Acme Co", data);
    expect(sendPushToTenantUsersMock).not.toHaveBeenCalled();
  });

  it("routes { kind: 'tenant' } payloads through sendPushToTenantUsers, passing excludeUserId", async () => {
    const handler = await loadHandler();
    sendPushToTenantUsersMock.mockResolvedValue(OK_REPORT);

    const data = { leadId: 999 };
    await handler({
      target: { kind: "tenant", tenantId: 5, excludeUserId: 77 },
      title: "Heads up",
      body: "New lead just arrived",
      data,
      enqueuedAt: Date.now(),
      source: "tenant-broadcast",
    });

    expect(sendPushToTenantUsersMock).toHaveBeenCalledTimes(1);
    expect(sendPushToTenantUsersMock).toHaveBeenCalledWith(
      5,
      "Heads up",
      "New lead just arrived",
      data,
      77,
    );
    expect(sendPushToUserMock).not.toHaveBeenCalled();
  });

  it("throws when the report has a top-level error (so the job is retried)", async () => {
    const handler = await loadHandler();
    const topLevelError = new Error("DB lookup failed");
    sendPushToUserMock.mockResolvedValue({
      attempted: 0,
      succeeded: 0,
      permanentFailures: 0,
      transientFailures: 0,
      topLevelError,
    });

    await expect(
      handler({
        target: { kind: "user", userId: 1 },
        title: "T",
        body: "B",
        enqueuedAt: Date.now(),
        source: "test-top-level",
      }),
    ).rejects.toBe(topLevelError);
  });

  it("throws when all deliveries hit transient failures and none succeeded", async () => {
    const handler = await loadHandler();
    sendPushToUserMock.mockResolvedValue({
      attempted: 2,
      succeeded: 0,
      permanentFailures: 0,
      transientFailures: 2,
      topLevelError: null,
    });

    await expect(
      handler({
        target: { kind: "user", userId: 1 },
        title: "T",
        body: "B",
        enqueuedAt: Date.now(),
        source: "test-transient-only",
      }),
    ).rejects.toThrow(/transient/i);
  });

  it("resolves successfully when at least one device succeeded even if others failed transiently", async () => {
    const handler = await loadHandler();
    sendPushToUserMock.mockResolvedValue({
      attempted: 3,
      succeeded: 1,
      permanentFailures: 0,
      transientFailures: 2,
      topLevelError: null,
    });

    const result = await handler({
      target: { kind: "user", userId: 1 },
      title: "T",
      body: "B",
      enqueuedAt: Date.now(),
      source: "test-partial-success",
    });

    expect(result).toMatchObject({
      attempted: 3,
      succeeded: 1,
      transientFailures: 2,
      permanentFailures: 0,
    });
  });

  it("resolves successfully when only permanent failures occurred (no retry on dead tokens)", async () => {
    const handler = await loadHandler();
    sendPushToUserMock.mockResolvedValue({
      attempted: 2,
      succeeded: 0,
      permanentFailures: 2,
      transientFailures: 0,
      topLevelError: null,
    });

    const result = await handler({
      target: { kind: "user", userId: 1 },
      title: "T",
      body: "B",
      enqueuedAt: Date.now(),
      source: "test-permanent-only",
    });

    expect(result).toMatchObject({
      attempted: 2,
      succeeded: 0,
      permanentFailures: 2,
      transientFailures: 0,
    });
  });
});
