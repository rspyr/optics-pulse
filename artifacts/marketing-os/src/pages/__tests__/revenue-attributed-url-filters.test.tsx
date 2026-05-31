// Coverage for persisting the Revenue Attributed funnel/source/match-level
// filters in the URL query string so a filtered view is shareable and survives
// a refresh (Task #806).
//
// This pins two behaviours:
//   1. Loading the page with `funnel`, `source`, and `matchLevel` query params
//      pre-selects those filters and forwards them on the list/summary fetches
//      (i.e. the view loads pre-filtered, surviving a refresh).
//   2. Changing a filter in the UI reflects the new value back into the URL via
//      history.replaceState, and clearing filters strips the params again.

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

import RevenueAttributed, { type RevenueJob } from "../revenue-attributed";
import { makeTenantFilterStub } from "@/test-utils/use-tenant-filter-mocks";
import { makeAuthStub } from "@/test-utils/auth-context-mocks";

const TENANT_ID = 42;

const allJobs: RevenueJob[] = [
  {
    id: 1, tenantId: TENANT_ID, stJobId: "ST-1", stInvoiceId: "INV-1",
    customerName: "Roofing Match", jobType: "install", jobTypeName: "Install",
    status: "completed", revenue: 1000, invoiceTotal: 900, invoiceRebateAmount: 150,
    correctedRevenue: 1050, invoiceDate: "2026-05-01", completedAt: "2026-05-01",
    createdAt: "2026-05-01", matchLevel: "gclid", matchedGclid: "g1",
    funnel: "Roofing", source: "Google",
    rebateBreakdown: [], soldByName: null, lead: null,
  },
  {
    id: 2, tenantId: TENANT_ID, stJobId: "ST-2", stInvoiceId: "INV-2",
    customerName: "Roofing Unmatched", jobType: "repair", jobTypeName: "Repair",
    status: "completed", revenue: 500, invoiceTotal: 500, invoiceRebateAmount: null,
    correctedRevenue: 500, invoiceDate: "2026-05-02", completedAt: "2026-05-02",
    createdAt: "2026-05-02", matchLevel: null, matchedGclid: null,
    funnel: "Roofing", source: "Facebook",
    rebateBreakdown: [], soldByName: null, lead: null,
  },
  {
    id: 3, tenantId: TENANT_ID, stJobId: "ST-3", stInvoiceId: null,
    customerName: "HVAC Manual", jobType: "service", jobTypeName: "Service",
    status: "completed", revenue: 750, invoiceTotal: null, invoiceRebateAmount: null,
    correctedRevenue: 750, invoiceDate: null, completedAt: null,
    createdAt: "2026-05-03", matchLevel: "manual", matchedGclid: null,
    funnel: "HVAC", source: "Google",
    rebateBreakdown: [], soldByName: null, lead: null,
  },
];

const FACETS = {
  funnels: ["Roofing", "HVAC"],
  sources: ["Google", "Facebook"],
  matchLevels: ["gclid", "manual", "unmatched"],
};

function paramsOf(url: string): URLSearchParams {
  return new URLSearchParams(url.split("?")[1] ?? "");
}

const listUrls: string[] = [];
const summaryUrls: string[] = [];

// URL-aware fetch mirroring the real endpoints: list + summary honour the
// funnel/source/matchLevel params (returning the server-filtered subset),
// facets always offer every value.
function installFetch() {
  vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/drilldown/revenue-attributed/facets")) {
      return { ok: true, status: 200, json: async () => FACETS } as Response;
    }
    const p = paramsOf(url);
    const funnel = p.get("funnel");
    const source = p.get("source");
    const levels = p.getAll("matchLevel");
    const filtered = allJobs.filter((j) => {
      if (funnel && j.funnel !== funnel) return false;
      if (source && j.source !== source) return false;
      if (levels.length > 0 && !levels.includes(j.matchLevel ?? "unmatched")) return false;
      return true;
    });
    if (url.includes("/api/drilldown/revenue-attributed/summary")) {
      summaryUrls.push(url);
      const summary = {
        revenue: filtered.reduce((s, j) => s + j.correctedRevenue, 0),
        rebates: filtered.reduce((s, j) => s + (j.invoiceRebateAmount ?? 0), 0),
        attributed: filtered.reduce(
          (s, j) => s + (j.matchLevel != null && j.matchLevel !== "unmatched" ? j.correctedRevenue : 0),
          0,
        ),
        count: filtered.length,
      };
      return { ok: true, status: 200, json: async () => summary } as Response;
    }
    if (url.includes("/api/drilldown/revenue-attributed")) {
      listUrls.push(url);
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k === "X-Total-Count" ? String(filtered.length) : null) },
        json: async () => filtered,
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
  summaryUrls.length = 0;
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

describe("Revenue Attributed — URL-persisted filters (Task #806)", () => {
  it("loads filters from the URL, pre-selects them, and forwards them on fetch", async () => {
    setUser();
    installFetch();
    // Simulate opening a shared / refreshed link: Roofing + Facebook + unmatched.
    setUrl("?funnel=Roofing&source=Facebook&matchLevel=unmatched");
    render(<RevenueAttributed />);

    // Only the Roofing/Facebook/unmatched job survives the combined filter.
    await screen.findByText("Roofing Unmatched");
    expect(screen.queryByText("Roofing Match")).not.toBeInTheDocument();
    expect(screen.queryByText("HVAC Manual")).not.toBeInTheDocument();

    // The match-level trigger reflects the URL state (single selection shows
    // the tier name rather than "All match levels").
    expect(screen.getByRole("button", { name: /^unmatched$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /all match levels/i })).not.toBeInTheDocument();

    // The list + summary fetches carried all three params.
    await waitFor(() => {
      const p = paramsOf(listUrls[listUrls.length - 1]);
      expect(p.get("funnel")).toBe("Roofing");
      expect(p.get("source")).toBe("Facebook");
      expect(p.getAll("matchLevel")).toEqual(["unmatched"]);
    });
    const sp = paramsOf(summaryUrls[summaryUrls.length - 1]);
    expect(sp.get("funnel")).toBe("Roofing");
    expect(sp.get("source")).toBe("Facebook");
    expect(sp.getAll("matchLevel")).toEqual(["unmatched"]);
  });

  it("writes filter changes back into the URL and strips them on clear", async () => {
    setUser();
    installFetch();
    const user = userEvent.setup();
    render(<RevenueAttributed />);

    await screen.findByText("Roofing Match");
    // No filters yet → clean URL.
    expect(window.location.search).toBe("");

    // Pick a match level; the URL should gain a matchLevel param.
    await user.click(screen.getByRole("button", { name: /all match levels/i }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /manual/i }));
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(paramsOf(window.location.search).getAll("matchLevel")).toEqual(["manual"]);
    });

    // Clear filters wipes the params from the URL again.
    await user.click(await screen.findByRole("button", { name: /clear filters/i }));
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
  });
});
