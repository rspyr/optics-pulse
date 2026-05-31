// Component coverage for the Revenue Attributed Match Level multi-select filter
// (Task #805).
//
// The route tests prove the backend honours a `matchLevel` param. This file
// closes the front-end gap: it drives the real DropdownMenu multi-select and
// asserts (1) the selection is forwarded as `matchLevel` query params on the
// list + summary fetches, (2) the visible list narrows to the matching rows,
// and (3) "Clear filters" resets the selection (and the list reloads unfiltered).

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

// Three completed jobs spanning the tiers the filter must distinguish:
//   id 1 — gclid (a real match)
//   id 2 — NULL matchLevel → the "unmatched" bucket
//   id 3 — manual (a real match)
const allJobs: RevenueJob[] = [
  {
    id: 1, tenantId: TENANT_ID, stJobId: "ST-1", stInvoiceId: "INV-1",
    customerName: "Acme HVAC", jobType: "install", jobTypeName: "Install",
    status: "completed", revenue: 1000, invoiceTotal: 900, invoiceRebateAmount: 150,
    correctedRevenue: 1050, invoiceDate: "2026-05-01", completedAt: "2026-05-01",
    createdAt: "2026-05-01", matchLevel: "gclid", matchedGclid: "g1",
    rebateBreakdown: [], soldByName: null, lead: null,
  },
  {
    id: 2, tenantId: TENANT_ID, stJobId: "ST-2", stInvoiceId: "INV-2",
    customerName: "Unmatched Co", jobType: "repair", jobTypeName: "Repair",
    status: "completed", revenue: 500, invoiceTotal: 500, invoiceRebateAmount: null,
    correctedRevenue: 500, invoiceDate: "2026-05-02", completedAt: "2026-05-02",
    createdAt: "2026-05-02", matchLevel: null, matchedGclid: null,
    rebateBreakdown: [], soldByName: null, lead: null,
  },
  {
    id: 3, tenantId: TENANT_ID, stJobId: "ST-3", stInvoiceId: null,
    customerName: "Manual Co", jobType: "service", jobTypeName: "Service",
    status: "completed", revenue: 750, invoiceTotal: null, invoiceRebateAmount: null,
    correctedRevenue: 750, invoiceDate: null, completedAt: null,
    createdAt: "2026-05-03", matchLevel: "manual", matchedGclid: null,
    rebateBreakdown: [], soldByName: null, lead: null,
  },
];

const FACETS = { funnels: [], sources: [], matchLevels: ["gclid", "manual", "unmatched"] };

// Returns ALL matchLevel values in a request URL (the page appends one param
// per selected tier).
function matchLevelsInUrl(url: string): string[] {
  const qs = url.split("?")[1] ?? "";
  return [...new URLSearchParams(qs).getAll("matchLevel")];
}

const listUrls: string[] = [];
const summaryUrls: string[] = [];

// URL-aware fetch mirroring the real endpoints: list + summary honour the
// matchLevel params (returning the server-filtered subset), facets always offer
// every tier. This lets the test drive the real dropdown and prove the param
// propagation + list narrowing.
function installFetch() {
  vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/drilldown/revenue-attributed/facets")) {
      return { ok: true, status: 200, json: async () => FACETS } as Response;
    }
    const levels = matchLevelsInUrl(url);
    const filtered = levels.length === 0
      ? allJobs
      : allJobs.filter((j) => levels.includes(j.matchLevel ?? "unmatched"));
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

beforeEach(() => {
  listUrls.length = 0;
  summaryUrls.length = 0;
  useTenantFilterMock.mockReset();
  useAuthMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  // Radix menus drive interaction through pointer capture + scrollIntoView,
  // neither of which jsdom implements; stub them so the dropdown opens.
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Revenue Attributed — Match Level multi-select filter (Task #805)", () => {
  it("forwards the selected tiers as matchLevel params and narrows the list, then clears", async () => {
    setUser();
    installFetch();
    const user = userEvent.setup();
    render(<RevenueAttributed />);

    // Unfiltered load shows every tier's row.
    await screen.findByText("Acme HVAC");
    expect(screen.getByText("Unmatched Co")).toBeInTheDocument();
    expect(screen.getByText("Manual Co")).toBeInTheDocument();

    // Open the Match Level dropdown (trigger shows "All match levels").
    const trigger = screen.getByRole("button", { name: /all match levels/i });
    await user.click(trigger);

    // Select "gclid" — only the gclid row should remain.
    const gclidItem = await screen.findByRole("menuitemcheckbox", { name: /gclid/i });
    await user.click(gclidItem);
    // The menu is modal (Radix marks the rest of the page aria-hidden while
    // open); close it so role-based queries can see the toolbar again.
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("Unmatched Co")).not.toBeInTheDocument());
    expect(screen.queryByText("Manual Co")).not.toBeInTheDocument();
    expect(screen.getByText("Acme HVAC")).toBeInTheDocument();

    // Both the list and summary fetches carried matchLevel=gclid.
    expect(listUrls.some((u) => matchLevelsInUrl(u).join(",") === "gclid")).toBe(true);
    expect(summaryUrls.some((u) => matchLevelsInUrl(u).join(",") === "gclid")).toBe(true);

    // Clear filters resets the selection and reloads the full list.
    const clearBtn = await screen.findByRole("button", { name: /clear filters/i });
    await user.click(clearBtn);

    await screen.findByText("Unmatched Co");
    expect(screen.getByText("Manual Co")).toBeInTheDocument();
    // The most recent list fetch carried no matchLevel param.
    expect(matchLevelsInUrl(listUrls[listUrls.length - 1])).toEqual([]);
  });

  it("folds NULL matchLevel into the 'unmatched' option (unmatched → the NULL-tier row)", async () => {
    setUser();
    installFetch();
    const user = userEvent.setup();
    render(<RevenueAttributed />);

    await screen.findByText("Acme HVAC");

    const trigger = screen.getByRole("button", { name: /all match levels/i });
    await user.click(trigger);
    const unmatchedItem = await screen.findByRole("menuitemcheckbox", { name: /unmatched/i });
    await user.click(unmatchedItem);

    // Only the NULL-tier job (treated as "unmatched") survives.
    await waitFor(() => expect(screen.queryByText("Acme HVAC")).not.toBeInTheDocument());
    expect(screen.queryByText("Manual Co")).not.toBeInTheDocument();
    expect(screen.getByText("Unmatched Co")).toBeInTheDocument();
    expect(listUrls.some((u) => matchLevelsInUrl(u).join(",") === "unmatched")).toBe(true);
  });
});
