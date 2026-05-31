// Coverage for persisting the Revenue Attributed column sort (key + direction)
// and current page number in the URL query string, so a "sorted by date, page 3"
// view is shareable and survives a refresh (Task #808). This extends the filter
// persistence (Task #806) to the remaining table state.
//
// This pins two behaviours:
//   1. Loading the page with `sort`, `dir`, and `page` query params pre-applies
//      that sort/page and forwards them on the list fetch (the view loads
//      sorted + on the right page, surviving a refresh).
//   2. Changing the sort or page in the UI reflects the new value back into the
//      URL via history.replaceState (and the default sort/first page stay
//      implicit, i.e. no params).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { useTenantFilterMock, useAuthMock, toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  useTenantFilterMock: vi.fn(),
  useAuthMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("@/hooks/use-tenant-filter", async () => {
  const { mockUseTenantFilterModule } = await import("@/test-utils/use-tenant-filter-mocks");
  return mockUseTenantFilterModule({
    useTenantFilter: useTenantFilterMock as unknown as typeof import("@/hooks/use-tenant-filter")["useTenantFilter"],
  });
});

vi.mock("@/components/auth-context", async () => {
  const { mockAuthContextModule } = await import("@/test-utils/auth-context-mocks");
  return mockAuthContextModule({
    useAuth: useAuthMock as unknown as typeof import("@/components/auth-context")["useAuth"],
  });
});

vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

import RevenueAttributed from "../revenue-attributed";
import { makeTenantFilterStub } from "@/test-utils/use-tenant-filter-mocks";
import { makeAuthStub } from "@/test-utils/auth-context-mocks";

const TENANT_ID = 42;
const PAGE_SIZE = 200;

function makeJob(id: number) {
  return {
    id,
    tenantId: TENANT_ID,
    stJobId: `ST-${id}`,
    stInvoiceId: null,
    customerName: `Customer ${id}`,
    jobType: "install",
    jobTypeName: "Install",
    status: "completed",
    revenue: 1000,
    invoiceTotal: 1000,
    invoiceRebateAmount: null,
    correctedRevenue: 1000,
    invoiceDate: "2026-05-01",
    completedAt: "2026-05-01",
    createdAt: "2026-05-01",
    matchLevel: null,
    matchedGclid: null,
    rebateBreakdown: [],
    soldByName: null,
    lead: null,
  };
}

const FACETS = { funnels: [], sources: [], matchLevels: [] };

function paramsOf(url: string): URLSearchParams {
  return new URLSearchParams(url.split("?")[1] ?? "");
}

const listUrls: string[] = [];

// Serves PAGE_SIZE-sized pages keyed off the offset query param, reporting the
// true total via X-Total-Count so the pager exposes Next/Previous controls.
function installFetch(total: number) {
  vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/drilldown/revenue-attributed/facets")) {
      return { ok: true, status: 200, json: async () => FACETS } as Response;
    }
    if (url.includes("/api/drilldown/revenue-attributed/summary")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ revenue: 0, rebates: 0, attributed: 0, count: 0 }),
      } as Response;
    }
    if (url.includes("/api/drilldown/revenue-attributed")) {
      listUrls.push(url);
      const offset = Number(paramsOf(url).get("offset") ?? "0");
      const count = Math.max(0, Math.min(PAGE_SIZE, total - offset));
      const body = Array.from({ length: count }, (_, i) => makeJob(offset + i + 1));
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name.toLowerCase() === "x-total-count" ? String(total) : null),
        },
        json: async () => body,
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

function setUser() {
  useTenantFilterMock.mockReturnValue(
    makeTenantFilterStub({
      isAgency: true,
      effectiveTenantId: TENANT_ID,
      localTenantId: TENANT_ID,
      tenants: [{ id: TENANT_ID, name: "Acme" }],
    }),
  );
  useAuthMock.mockReturnValue(
    makeAuthStub({
      user: {
        id: 1, email: "agency@acme.test", name: "Agency Op", role: "agency_user",
        tenantId: TENANT_ID, tenantName: "Acme", leaderboardConfig: null,
      },
      isAgency: true,
      isClient: false,
      effectiveTenantId: TENANT_ID,
    }),
  );
}

function setUrl(search: string) {
  window.history.replaceState(null, "", `/${search}`);
}

beforeEach(() => {
  listUrls.length = 0;
  useTenantFilterMock.mockReset();
  useAuthMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  setUrl("");
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
  setUrl("");
});

describe("Revenue Attributed — URL-persisted sort + page (Task #808)", () => {
  it("loads sort + page from the URL and forwards them on fetch", async () => {
    setUser();
    installFetch(3 * PAGE_SIZE);
    // Simulate opening a shared / refreshed link: sorted by date asc, page 3.
    setUrl("?sort=date&dir=asc&page=3");
    render(<RevenueAttributed />);

    // Page 3 (0-based offset 400) rows render, proving the page was restored.
    await screen.findByText("Customer 401");
    expect(
      screen.getByText("Showing 401–600 of 600 jobs · Page 3 of 3"),
    ).toBeInTheDocument();

    // The list fetch carried the restored sort/dir/offset.
    await waitFor(() => {
      const p = paramsOf(listUrls[listUrls.length - 1]);
      expect(p.get("sort")).toBe("date");
      expect(p.get("dir")).toBe("asc");
      expect(p.get("offset")).toBe(String(2 * PAGE_SIZE));
    });
  });

  it("writes sort changes back into the URL and keeps the default implicit", async () => {
    setUser();
    installFetch(PAGE_SIZE);
    const user = userEvent.setup();
    render(<RevenueAttributed />);

    await screen.findByText("Customer 1");
    // Default sort (revenue/desc), first page → clean URL.
    expect(window.location.search).toBe("");

    // Sort by the Date column header. A new column starts descending, which is
    // the default direction, so `dir` stays implicit (absent) — only `sort` is set.
    await user.click(screen.getByRole("button", { name: /sort by date/i }));
    await waitFor(() => {
      const p = paramsOf(window.location.search);
      expect(p.get("sort")).toBe("date");
      expect(p.get("dir")).toBeNull();
    });

    // Clicking it again flips direction to asc, reflected in the URL.
    await user.click(screen.getByRole("button", { name: /sort by date/i }));
    await waitFor(() => {
      expect(paramsOf(window.location.search).get("dir")).toBe("asc");
    });
  });

  it("writes the page number into the URL (1-based) and clears it on page 1", async () => {
    setUser();
    installFetch(2 * PAGE_SIZE);
    const user = userEvent.setup();
    render(<RevenueAttributed />);

    await screen.findByText("Customer 1");
    expect(window.location.search).toBe("");

    // Advance to page 2 → URL gains page=2.
    await user.click(screen.getByRole("button", { name: /next/i }));
    await screen.findByText("Customer 201");
    await waitFor(() => {
      expect(paramsOf(window.location.search).get("page")).toBe("2");
    });

    // Back to page 1 → page param stripped (default is implicit).
    await user.click(screen.getByRole("button", { name: /previous/i }));
    await screen.findByText("Customer 1");
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
  });
});
