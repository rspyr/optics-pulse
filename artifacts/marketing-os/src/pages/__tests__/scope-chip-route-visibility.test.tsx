import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AuthProvider } from "@/components/auth-context";
import { AppLayout } from "@/components/layout";

// The header SCOPE chip is supposed to disappear on routes where the chip
// has no effect on the page being shown — tenant/user admin pages, agency-
// wide lists like /leaderboards and /automation, and global LMS/script
// surfaces. These tests lock that route → visibility contract in place so
// it doesn't regress.

const tenantList = [
  { id: 11, name: "Acme", isActive: true },
  { id: 22, name: "Beta", isActive: true },
];

vi.mock("@workspace/api-client-react", async () => {
  // TenantScopeChip reads the tenant list via this hook to populate its
  // dropdown. Returning a small list is enough to exercise the visibility
  // branch — we never actually open the menu in these tests. Every other
  // auto-generated hook stays a safe no-result stub via the shared helper.
  const { mockApiClientReactModule, makeApiClientHookStub } = await import(
    "@/test-utils/api-client-react-mocks"
  );
  return mockApiClientReactModule({
    useListTenants: (() => ({
      ...makeApiClientHookStub(),
      data: tenantList,
    })) as unknown as typeof import("@workspace/api-client-react").useListTenants,
  });
});

// useBranding pulls in additional API calls we don't care about here.
vi.mock("@/hooks/use-branding", () => ({ useBranding: () => undefined }));

// ChatDrawer / NotificationBell pull in sockets and other side effects that
// would otherwise spam the test. Stub them out to render to nothing.
vi.mock("@/components/chat-drawer", () => ({
  default: () => null,
}));
vi.mock("@/components/notification-bell", () => ({
  NotificationBell: () => <div data-testid="notification-bell" />,
}));

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
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
    return { ok: true, json: async () => ({}) } as Response;
  });
}

function renderAt(path: string) {
  const { hook } = memoryLocation({ path });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <AuthProvider>
          <AppLayout>
            <div data-testid="page-body">page</div>
          </AppLayout>
        </AuthProvider>
      </Router>
    </QueryClientProvider>,
  );
}

const HIDDEN_ROUTES = [
  "/leaderboards",
  "/admin/tenants",
  "/admin/users",
  "/automation",
  "/admin/funnels",
  "/admin/scripts",
  "/admin/training",
  "/admin/change-logs",
];

const VISIBLE_ROUTES = [
  "/",
  "/internal",
  "/pulse",
  "/sales-manager",
  "/clients",
  "/attribution",
  "/settings",
];

describe("SCOPE chip visibility — hidden on agency-wide routes, visible on tenant-scoped routes", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", makeFetchMock());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  for (const route of HIDDEN_ROUTES) {
    it(`hides the SCOPE chip on ${route}`, async () => {
      renderAt(route);
      // Wait for auth to resolve so isAgency flips true and the header bar
      // (which contains the chip + notification bell) renders.
      await waitFor(() => {
        expect(screen.getByTestId("notification-bell")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("tenant-scope-chip")).not.toBeInTheDocument();
    });
  }

  for (const route of VISIBLE_ROUTES) {
    it(`shows the SCOPE chip on ${route}`, async () => {
      renderAt(route);
      await waitFor(() => {
        expect(screen.getByTestId("tenant-scope-chip")).toBeInTheDocument();
      });
    });
  }

  it("also hides the chip on nested children of a deny-listed route (e.g. /admin/tenants/42)", async () => {
    renderAt("/admin/tenants/42");
    await waitFor(() => {
      expect(screen.getByTestId("notification-bell")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("tenant-scope-chip")).not.toBeInTheDocument();
  });

  it("never renders the chip for a non-agency user, even on tenant-scoped routes", async () => {
    // Override the default fetch mock for this test to return a client user.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/auth/me")) {
          return {
            ok: true,
            json: async () => ({
              id: 9,
              email: "user@client.test",
              name: "Client User",
              role: "client_user",
              tenantId: 11,
              tenantName: "Acme",
              leaderboardConfig: null,
            }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    renderAt("/pulse");
    // For client users the layout doesn't render the header bar at all
    // (it's gated on isAgency), so neither the bell nor the chip should
    // appear. Wait a tick to let the auth fetch resolve.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("tenant-scope-chip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notification-bell")).not.toBeInTheDocument();
  });
});
