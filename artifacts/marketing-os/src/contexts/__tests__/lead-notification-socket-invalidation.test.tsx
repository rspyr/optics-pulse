// Task #589: Prove the live socket actually triggers the badge flip — not
// just a stubbed invalidation.
//
// The smoke test from Task #585 stubs the SSE channel with an explicit
// `queryClient.invalidateQueries` call to drive the row badge from UNMATCHED
// to MANUAL after a rule save. That covers the POST → DB → UI half of the
// handshake but leaves the *socket-driven* half unverified: in production,
// after the server flips the attribution event to `manual`, the tenant
// socket room emits `rule-rederive-complete`, and the marketing-os client
// is supposed to listen for it and invalidate the attribution-events list
// (+ detail) queries on its own. If that wire goes missing, the badge
// silently stops flipping — exactly the regression the smoke test was
// supposed to guard.
//
// This test mounts the *real* `LeadNotificationProvider` with a controllable
// mock `socket.io-client`, fires the tenant-room event after a "rule save"
// (we just hand-fire it on the captured socket handler), and asserts that
// the attribution-events list and detail queries are invalidated WITHOUT
// any manual `invalidateQueries` call in the test body. Remove the handler
// in lead-notification-context.tsx and this test fails.

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

describe("LeadNotificationProvider — socket-driven attribution-events invalidation (Task #589)", () => {
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    socketState.handlers.clear();
    socketState.disconnected = false;
    // jsdom doesn't ship AudioContext / Audio; stub just enough so the
    // provider's audio-unlock + sound-prefetch effects don't blow up.
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

  it("invalidates the attribution-events list AND detail queries when the tenant socket emits rule-rederive-complete (proving the live wire flips the badge, not just a test-driven invalidate)", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <LeadNotificationProvider>
          <div />
        </LeadNotificationProvider>
      </QueryClientProvider>,
    );

    // The provider must have registered a real `rule-rederive-complete`
    // socket handler — otherwise the server's emit after a rule save would
    // never reach the client and the badge would silently stop flipping.
    const handler = socketState.handlers.get("rule-rederive-complete");
    expect(handler).toBeDefined();

    // Reset the spy so the assertion below only counts invalidations driven
    // by the socket event, not any incidental ones during mount.
    invalidateSpy.mockClear();

    // Simulate the server's tenant-room emit after the operator saved a
    // mapping rule (which the server uses to flip the event to MANUAL and
    // then enqueues the historical re-derive job that ultimately emits
    // this event).
    act(() => {
      handler!({
        tenantId: 42,
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form-1",
        leadsChanged: 3,
        hitLimit: false,
        maxLeads: 1000,
      });
    });

    // The list query MUST be invalidated by the socket handler itself —
    // not by any test-driven `queryClient.invalidateQueries` call.
    expect(
      findCallWithQueryKey(invalidateSpy, getListAttributionEventsQueryKey()),
    ).toBeTruthy();

    // The detail-query prefix MUST also be invalidated so an open event
    // sheet refetches the freshly-flipped `matchLevel: "manual"` payload.
    expect(findCallWithQueryKey(invalidateSpy, ["attribution-event"])).toBeTruthy();
  });

  it("ignores rule-rederive-complete from a different tenant (no cross-tenant query invalidation)", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <LeadNotificationProvider>
          <div />
        </LeadNotificationProvider>
      </QueryClientProvider>,
    );

    const handler = socketState.handlers.get("rule-rederive-complete");
    expect(handler).toBeDefined();
    invalidateSpy.mockClear();

    act(() => {
      handler!({
        tenantId: 999, // different tenant — provider is scoped to tenant 42
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form-1",
        leadsChanged: 3,
        hitLimit: false,
        maxLeads: 1000,
      });
    });

    expect(
      findCallWithQueryKey(invalidateSpy, getListAttributionEventsQueryKey()),
    ).toBeFalsy();
    expect(findCallWithQueryKey(invalidateSpy, ["attribution-event"])).toBeFalsy();
  });
});
