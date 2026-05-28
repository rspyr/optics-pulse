// Component coverage for offset-based paging on the Revenue Attributed page
// (Task #679). The list used to silently stop at 200 rows; it now pages with
// Previous/Next controls driven by limit+offset query params.
//
// The contract this file locks in — none of which the API route tests can see:
//
//   1. The first page request sends limit=PAGE_SIZE & offset=0, and clicking
//      Next advances the offset by a full page.
//   2. Navigating onto an EMPTY page (which happens when the total is an exact
//      multiple of the page size) must NOT strand the user: the Previous
//      control stays visible and usable so they can go back.
//   3. Clicking Previous from that empty page returns to the prior full page.

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

// A full first page (exactly PAGE_SIZE rows) followed by an empty second page —
// the worst case for "is there more?" inference and the one that used to hide
// the pager and strand the user.
const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => makeJob(i + 1));

let listCallUrls: string[] = [];

function installFetch() {
  vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/drilldown/revenue-attributed")) {
      listCallUrls.push(url);
      const offset = Number(new URL(url, "http://x").searchParams.get("offset") ?? "0");
      const body = offset >= PAGE_SIZE ? [] : fullPage;
      return { ok: true, status: 200, json: async () => body } as Response;
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
        id: 1,
        email: "agency@acme.test",
        name: "Agency Op",
        role: "agency_user",
        tenantId: TENANT_ID,
        tenantName: "Acme",
        leaderboardConfig: null,
      },
      isAgency: true,
      isClient: false,
      effectiveTenantId: TENANT_ID,
    }),
  );
}

beforeEach(() => {
  listCallUrls = [];
  useTenantFilterMock.mockReset();
  useAuthMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Revenue Attributed — offset paging (Task #679)", () => {
  it("requests the first page with limit & offset=0", async () => {
    setUser();
    installFetch();
    render(<RevenueAttributed />);

    await screen.findByText("Customer 1");
    expect(listCallUrls).toHaveLength(1);
    expect(listCallUrls[0]).toContain(`limit=${PAGE_SIZE}`);
    expect(listCallUrls[0]).toContain("offset=0");
  });

  it("advances by a full page on Next and keeps Previous usable on an empty page", async () => {
    setUser();
    installFetch();
    const user = userEvent.setup();
    render(<RevenueAttributed />);

    // Page 1: full page, Next enabled (inferred from a full page).
    await screen.findByText("Customer 1");
    const next = screen.getByRole("button", { name: /next/i });
    expect(next).toBeEnabled();
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();

    // Click Next → page 2 fetched at offset=PAGE_SIZE, returns empty.
    await user.click(next);

    await waitFor(() =>
      expect(listCallUrls.some((u) => u.includes(`offset=${PAGE_SIZE}`))).toBe(true),
    );

    // The empty page must NOT strand the user: Previous stays visible & usable,
    // Next is disabled (an empty page is never "full").
    const prev = await screen.findByRole("button", { name: /previous/i });
    expect(prev).toBeEnabled();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();

    // Click Previous → back to page 1 (offset=0), full page restored.
    await user.click(prev);
    await screen.findByText("Customer 1");
    const offsetZeroCalls = listCallUrls.filter((u) => u.includes("offset=0"));
    expect(offsetZeroCalls.length).toBeGreaterThanOrEqual(2);
  });
});
