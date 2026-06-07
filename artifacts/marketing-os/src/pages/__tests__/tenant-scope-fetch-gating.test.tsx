import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AuthProvider, useAuth } from "@/components/auth-context";

// These two pages (Sales Manager and Pulse) used to fall back to the first
// tenant in the list whenever the operator hadn't picked one yet. That made
// it impossible for an admin to look at the "All Tenants" state, and worse —
// it silently leaked another tenant's data into the view. The fix is that
// every tenant-scoped fetch is now gated on a non-null tenant id. These
// tests pin that behavior in place.
//
// The contract under test:
//   * As an agency super_admin with `selectedTenantId === null` (explicit
//     "All Tenants"), neither page may issue a fetch whose URL contains a
//     tenantId query parameter or hits a known tenant-scoped path.
//   * Choosing a tenant must then trigger those fetches (sanity check that
//     we didn't just disable them altogether).

// Pulse pulls in framer-motion, react-query hooks, sockets and a notification
// provider that we don't want to exercise here. Stub the parts that aren't
// the focus of this test.
vi.mock("socket.io-client", () => ({
  io: () => ({
    on: () => undefined,
    off: () => undefined,
    emit: () => undefined,
    disconnect: () => undefined,
    connect: () => undefined,
  }),
}));

vi.mock("@/contexts/lead-notification-context", async () => {
  const { mockLeadNotificationModule } = await import("@/test-utils/lead-notification-mocks");
  return mockLeadNotificationModule();
});

vi.mock("@workspace/api-client-react", async () => {
  // The Pulse page reads a Podium timeline via these hooks when a lead is
  // selected — we never open one in these tests. Use the shared helper so
  // every other auto-generated hook also defaults to a safe empty result
  // (drift-proof: new hooks don't require touching this factory).
  const { mockApiClientReactModule } = await import(
    "@/test-utils/api-client-react-mocks"
  );
  return mockApiClientReactModule();
});

// Pulled in after the mocks so the page picks up the stubs.
import Pulse from "../pulse";
import SalesManager from "../sales-manager";

const STORAGE_KEY = "agencyGodView.tenantId";

const tenantList = [
  { id: 11, name: "Acme", timezone: "America/New_York" },
  { id: 22, name: "Beta", timezone: "America/Los_Angeles" },
];

interface FetchLog {
  url: string;
  method: string;
}

// Default-shape responses for endpoints the pages destructure into nested
// arrays. We don't care what the data says, only that the keys exist so the
// render doesn't crash after a sanity-check fetch lands.
function shapeFor(url: string): unknown {
  const path = url.split("?")[0];
  if (path.includes("/leads-hub/queue")) {
    return {
      newLeads: [], callbacks: [], reengagement: [],
      oldLeads: [], recentlyBooked: [], total: 0,
      timezone: "America/New_York",
    };
  }
  if (path.includes("/leads-hub/stats/timeseries")) return { series: [] };
  if (path.includes("/leads-hub/stats")) return { bySource: [], byFunnel: [], byCsr: [], byCsrByFunnel: [], totalLeads: 0, appointments: 0, bookingRate: 0, bookedInWindow: 0, spiffEarned: 0, activityBookingRate: 0 };
  if (path.includes("/leads-hub/csrs")) return { csrs: [] };
  if (path.includes("/leads-hub/routing-config")) return { configs: [] };
  if (path.includes("/leads-hub/my-pause")) return { isPaused: false, pauseSource: "manager" };
  if (path.includes("/leads-hub/archive")) return { leads: [], total: 0 };
  if (path.includes("/sales-manager/activity-feed")) return { activities: [] };
  if (path.includes("/sales-manager/coaching-insights")) return { insights: [] };
  if (path.includes("/sales-manager/spiff-config")) return {};
  if (path.includes("/leads/hud/stats")) {
    return {
      callsMadeToday: 0, bookingsToday: 0, bookingRate: 0, commission: 0,
      newLeadsToday: 0, avgSpeedToLead: 0, soldToday: 0,
      bonusTier: "none", bonusThreshold: 30, nextBonusAt: 30,
    };
  }
  if (path.includes("/leads/search")) return { leads: [], total: 0 };
  if (path.includes("/funnel-types")) return [];
  if (path.includes("/sheet-configs")) return [];
  return {};
}

function makeFetchMock(log: FetchLog[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    log.push({ url, method: (init?.method ?? "GET").toUpperCase() });

    if (url.endsWith("/api/auth/me")) {
      return {
        ok: true,
        json: async () => ({
          id: 1,
          email: "admin@agency.test",
          name: "Admin",
          role: "super_admin",
          tenantId: null,
          tenantName: null,
          leaderboardConfig: null,
        }),
      } as Response;
    }
    if (url.endsWith("/api/tenants") || url.endsWith("/tenants")) {
      return { ok: true, json: async () => tenantList } as Response;
    }
    // The "before selection" assertions just look at the URLs that were
    // logged, but the "after selection" sanity check also lets the pages
    // render past their loading state. Hand back shape-safe payloads for
    // the endpoints those pages destructure, so a sanity-check fetch
    // doesn't crash the component on a `.length` of an empty default.
    const body = shapeFor(url);
    return {
      ok: true,
      json: async () => body,
      text: async () => "",
    } as Response;
  });
}

// Anything matching this pattern is a fetch that must wait until a tenant
// is in scope: either it embeds tenantId in the path, or it queries one of
// the known per-tenant endpoints with `?tenantId=` (or no qs because the
// page would default to "the first tenant").
const TENANT_SCOPED_PATH_PREFIXES = [
  "/api/leads-hub/",
  "/api/leads/hud/",
  "/api/sales-manager/",
  "/api/funnel-types",
  "/api/leads/search",
  "/api/sheet-configs/",
];

function isTenantScopedCall(url: string): boolean {
  // Strip query string for path checks.
  const [path, qs = ""] = url.split("?");
  if (qs.includes("tenantId=")) return true;
  // /api/tenants/123/... is tenant-scoped; bare /api/tenants is the list.
  if (/\/api\/tenants\/\d+/.test(path)) return true;
  return TENANT_SCOPED_PATH_PREFIXES.some((p) => path.includes(p));
}

function AuthProbe({ onReady }: { onReady: (a: ReturnType<typeof useAuth>) => void }) {
  const auth = useAuth();
  React.useEffect(() => { onReady(auth); });
  return null;
}

function renderWithProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
}

describe("Tenant-scoped fetches are gated on a tenant being picked", () => {
  let fetchLog: FetchLog[];

  beforeEach(() => {
    fetchLog = [];
    window.localStorage.clear();
    // Seed an explicit "All Tenants" choice so the page can't claim it's
    // "still waiting on the operator to pick" — they have picked, and the
    // choice is the agency-wide view.
    window.localStorage.setItem(STORAGE_KEY, "all");
    vi.stubGlobal("fetch", makeFetchMock(fetchLog));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("Sales Manager does not issue any tenant-scoped fetch before a tenant is selected", async () => {
    let auth: ReturnType<typeof useAuth> | null = null;
    renderWithProviders(
      <>
        <AuthProbe onReady={(a) => { auth = a; }} />
        <SalesManager />
      </>,
    );

    // Wait until auth has resolved — only after this does isAgency flip to
    // true and the per-tenant gates apply. The contract under test is:
    // once the page knows the user is an agency operator with no tenant
    // picked, it must not fire any tenant-scoped fetch.
    await waitFor(() => expect(auth?.user?.role).toBe("super_admin"));
    await waitFor(() => {
      expect(fetchLog.some((c) => c.url.endsWith("/api/tenants"))).toBe(true);
    });
    // Drop everything logged so far — we're now in the steady "agency
    // operator, no tenant picked" state.
    fetchLog.length = 0;
    // Give downstream useEffects a chance to (incorrectly) fire.
    await new Promise((r) => setTimeout(r, 80));

    const offending = fetchLog.filter((c) => isTenantScopedCall(c.url));
    expect(
      offending,
      `Sales Manager fired tenant-scoped fetches with no tenant in scope:\n` +
        offending.map((c) => `  ${c.method} ${c.url}`).join("\n"),
    ).toEqual([]);
  });

  it("Pulse does not issue any tenant-scoped fetch before a tenant is selected", async () => {
    let auth: ReturnType<typeof useAuth> | null = null;
    renderWithProviders(
      <>
        <AuthProbe onReady={(a) => { auth = a; }} />
        <Pulse />
      </>,
    );

    await waitFor(() => expect(auth?.user?.role).toBe("super_admin"));
    await waitFor(() => {
      expect(fetchLog.some((c) => c.url.endsWith("/api/tenants"))).toBe(true);
    });
    fetchLog.length = 0;
    await new Promise((r) => setTimeout(r, 80));

    const offending = fetchLog.filter((c) => isTenantScopedCall(c.url));
    expect(
      offending,
      `Pulse fired tenant-scoped fetches with no tenant in scope:\n` +
        offending.map((c) => `  ${c.method} ${c.url}`).join("\n"),
    ).toEqual([]);
  });

  it("Sales Manager starts fetching tenant-scoped data once a tenant is selected (sanity check)", async () => {
    let auth: ReturnType<typeof useAuth> | null = null;
    renderWithProviders(
      <>
        <AuthProbe onReady={(a) => { auth = a; }} />
        <SalesManager />
      </>,
    );

    await waitFor(() => expect(auth?.user?.role).toBe("super_admin"));
    await waitFor(() => {
      expect(fetchLog.some((c) => c.url.endsWith("/api/tenants"))).toBe(true);
    });

    // Pick a tenant — this is the same path the header Scope chip invokes via
    // setSelectedTenantId.
    act(() => { auth!.setSelectedTenantId(11); });

    await waitFor(() => {
      expect(fetchLog.some((c) => isTenantScopedCall(c.url))).toBe(true);
    });
  });

  it("Pulse starts fetching tenant-scoped data once a tenant is selected (sanity check)", async () => {
    let auth: ReturnType<typeof useAuth> | null = null;
    renderWithProviders(
      <>
        <AuthProbe onReady={(a) => { auth = a; }} />
        <Pulse />
      </>,
    );

    await waitFor(() => expect(auth?.user?.role).toBe("super_admin"));
    await waitFor(() => {
      expect(fetchLog.some((c) => c.url.endsWith("/api/tenants"))).toBe(true);
    });

    act(() => { auth!.setSelectedTenantId(22); });

    await waitFor(() => {
      expect(fetchLog.some((c) => isTenantScopedCall(c.url))).toBe(true);
    });
  });
});
