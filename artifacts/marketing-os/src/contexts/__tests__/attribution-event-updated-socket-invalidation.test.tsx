// Task #593: prove the *synchronous* `attribution-event-updated` socket emit
// from the server's `markEventManuallyMatched` triggers the open event
// sheet's refetch — not just the background re-derive job's eventual
// `rule-rederive-complete` emit.
//
// Task #589's invalidation wire piggy-backs on `rule-rederive-complete`,
// which is fired by the *background* historical re-derive job some time
// AFTER the POST handler has already flipped the targeted event to `manual`
// via `markEventManuallyMatched`. Under slow job queue / retry conditions
// that gap leaves the open event sheet stale even after the row list has
// already flipped. Task #593 closes the gap by emitting
// `attribution-event-updated` synchronously from `markEventManuallyMatched`
// and having the client invalidate the same list + detail keys on it.
//
// This test mounts the *real* `LeadNotificationProvider` with a controllable
// mock `socket.io-client`, hand-fires `attribution-event-updated` on the
// captured socket handler, and asserts that the attribution-events list and
// detail queries are invalidated WITHOUT any manual `invalidateQueries`
// call in the test body. Remove the handler in lead-notification-context.tsx
// and this test fails.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getListAttributionEventsQueryKey } from "@workspace/api-client-react";

const { socketState, socketFactory } = vi.hoisted(() => {
  const state: {
    handlers: Map<string, (...args: unknown[]) => void>;
    disconnected: boolean;
  } = {
    handlers: new Map(),
    disconnected: false,
  };
  const factory = () => ({
    id: "mock-socket",
    on(event: string, handler: (...args: unknown[]) => void) {
      state.handlers.set(event, handler);
    },
    emit() {},
    disconnect() {
      state.disconnected = true;
    },
  });
  return { socketState: state, socketFactory: factory };
});

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => socketFactory()),
}));

vi.mock("@/components/auth-context", async () => {
  const { mockAuthContextModule, makeAuthStub } = await import(
    "@/test-utils/auth-context-mocks"
  );
  return mockAuthContextModule({
    useAuth: () =>
      makeAuthStub({
        user: { id: 1, role: "csr" } as never,
        effectiveTenantId: 42,
        isAgency: false,
      }),
  });
});

vi.mock("@/hooks/use-push-notifications", () => ({
  usePushNotifications: () => ({
    supported: false,
    permission: "default",
    subscribed: false,
    subscribe: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
  useToast: () => ({ toasts: [] }),
}));

import { LeadNotificationProvider } from "../lead-notification-context";

function findCallWithQueryKey(
  spy: ReturnType<typeof vi.spyOn>,
  expectedKey: readonly unknown[],
) {
  return spy.mock.calls.find(([arg]) => {
    const key = (arg as { queryKey?: unknown[] } | undefined)?.queryKey;
    if (!Array.isArray(key) || key.length !== expectedKey.length) return false;
    return key.every((v, i) => Object.is(v, expectedKey[i]));
  });
}

describe("LeadNotificationProvider — synchronous attribution-event-updated invalidation (Task #593)", () => {
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    socketState.handlers.clear();
    socketState.disconnected = false;
    (globalThis as unknown as { Audio: typeof Audio }).Audio = class {
      volume = 0;
      muted = false;
      currentTime = 0;
      load() {}
      play() { return Promise.resolve(); }
      pause() {}
      set src(_v: string) {}
    } as unknown as typeof Audio;
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
    );

    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    invalidateSpy.mockRestore();
    queryClient.clear();
  });

  it("invalidates the attribution-events list AND detail queries when the tenant socket emits attribution-event-updated (proving the open event sheet refetches the moment the server flips the row — not just when the background re-derive job finishes)", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <LeadNotificationProvider>
          <div />
        </LeadNotificationProvider>
      </QueryClientProvider>,
    );

    const handler = socketState.handlers.get("attribution-event-updated");
    expect(handler).toBeDefined();

    invalidateSpy.mockClear();

    // Simulate the server's synchronous emit from `markEventManuallyMatched`
    // right after it flipped an event to `manual` (POST handler path, before
    // the background re-derive job ever fires `rule-rederive-complete`).
    act(() => {
      handler!({
        tenantId: 42,
        eventId: 12345,
        matchLevel: "manual",
      });
    });

    expect(
      findCallWithQueryKey(invalidateSpy, getListAttributionEventsQueryKey()),
    ).toBeTruthy();
    expect(findCallWithQueryKey(invalidateSpy, ["attribution-event"])).toBeTruthy();
  });

  it("ignores attribution-event-updated from a different tenant (no cross-tenant query invalidation)", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <LeadNotificationProvider>
          <div />
        </LeadNotificationProvider>
      </QueryClientProvider>,
    );

    const handler = socketState.handlers.get("attribution-event-updated");
    expect(handler).toBeDefined();
    invalidateSpy.mockClear();

    act(() => {
      handler!({
        tenantId: 999, // different tenant — provider is scoped to tenant 42
        eventId: 12345,
        matchLevel: "manual",
      });
    });

    expect(
      findCallWithQueryKey(invalidateSpy, getListAttributionEventsQueryKey()),
    ).toBeFalsy();
    expect(findCallWithQueryKey(invalidateSpy, ["attribution-event"])).toBeFalsy();
  });
});
