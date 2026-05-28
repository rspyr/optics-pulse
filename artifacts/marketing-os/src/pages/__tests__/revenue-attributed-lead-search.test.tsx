// Component coverage for the agency-only lead-matching typeahead on the
// Revenue Attributed page (Task #673).
//
// Task #665 added API-level tests for the lead search + match endpoints, but
// the typeahead UI in `AgencyControls` had no automated coverage. The contract
// this file locks in, all of which is wiring that the route tests can't see:
//
//   1. Typing fewer than 2 characters never issues a `/leads/search` request
//      (the minimum-character guard in the debounce effect).
//   2. Typing >= 2 characters issues exactly one debounced search request and
//      renders the returned leads in the results dropdown.
//   3. Clicking a result fires the PATCH match call to
//      `/api/drilldown/jobs/<id>/lead` with that lead's id.
//   4. A failed match surfaces the server error message to the operator
//      (via a toast) rather than failing silently.
//   5. The whole box is agency-only — a client (read-only) user sees the
//      "managed by your agency" copy and no search input at all.

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
  const { mockUseTenantFilterModule } = await import(
    "@/test-utils/use-tenant-filter-mocks"
  );
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

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 9001,
    tenantId: TENANT_ID,
    stJobId: "ST-1",
    stInvoiceId: null,
    customerName: "Wile E. Coyote",
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
    ...overrides,
  };
}

function makeSearchResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 555,
    firstName: "Road",
    lastName: "Runner",
    phone: "555-0100",
    email: "rr@acme.test",
    source: "google",
    status: "new",
    createdAt: "2026-05-01",
    ...overrides,
  };
}

type FetchHandlers = {
  searchResults?: unknown[];
  searchOk?: boolean;
  matchOk?: boolean;
  matchError?: string;
};

let searchCallUrls: string[] = [];
let matchCalls: Array<{ url: string; body: unknown }> = [];

function installFetch(handlers: FetchHandlers = {}) {
  const {
    searchResults = [makeSearchResult()],
    searchOk = true,
    matchOk = true,
    matchError = "Lead belongs to a different tenant",
  } = handlers;

  vi.spyOn(global, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      // Jobs list (page load)
      if (url.includes("/api/drilldown/revenue-attributed")) {
        return {
          ok: true,
          status: 200,
          json: async () => [makeJob()],
        } as Response;
      }

      // Lead typeahead search
      if (url.includes("/api/drilldown/leads/search")) {
        searchCallUrls.push(url);
        if (!searchOk) {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => searchResults,
        } as Response;
      }

      // PATCH match job -> lead
      if (/\/api\/drilldown\/jobs\/\d+\/lead$/.test(url) && method === "PATCH") {
        matchCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
        if (!matchOk) {
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: matchError }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }

      return { ok: true, status: 200, json: async () => ({}) } as Response;
    },
  );
}

function setAgency(isAgency: boolean) {
  useTenantFilterMock.mockReturnValue(
    makeTenantFilterStub({
      isAgency,
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
        role: isAgency ? "agency_user" : "client_user",
        tenantId: TENANT_ID,
        tenantName: "Acme",
        leaderboardConfig: null,
      },
      isAgency,
      isClient: !isAgency,
      effectiveTenantId: TENANT_ID,
    }),
  );
}

// Render the page and expand the single job row so the AgencyControls (or the
// client read-only copy) inside JobDetail is mounted.
async function renderAndExpand() {
  const user = userEvent.setup();
  render(<RevenueAttributed />);
  const customerCell = await screen.findByText("Wile E. Coyote");
  await user.click(customerCell.closest("tr") as HTMLTableRowElement);
  return user;
}

beforeEach(() => {
  searchCallUrls = [];
  matchCalls = [];
  useTenantFilterMock.mockReset();
  useAuthMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Revenue Attributed — lead-matching typeahead (Task #673)", () => {
  it("does not issue a search request while fewer than 2 characters are typed", async () => {
    setAgency(true);
    installFetch();
    const user = await renderAndExpand();

    const box = await screen.findByPlaceholderText("Search by name, phone, or email");
    await user.type(box, "a");

    // Wait past the 250ms debounce window, then assert nothing was searched.
    await new Promise((r) => setTimeout(r, 500));
    expect(searchCallUrls).toHaveLength(0);
  });

  it("issues a debounced search and renders the returned leads once 2+ characters are typed", async () => {
    setAgency(true);
    installFetch({ searchResults: [makeSearchResult()] });
    const user = await renderAndExpand();

    const box = await screen.findByPlaceholderText("Search by name, phone, or email");
    await user.type(box, "ro");

    // Result renders (proves the search fired and resolved).
    await screen.findByText("Road Runner");

    // Exactly one debounced request, scoped to the job's tenant + query.
    expect(searchCallUrls).toHaveLength(1);
    expect(searchCallUrls[0]).toContain("q=ro");
    expect(searchCallUrls[0]).toContain(`tenantId=${TENANT_ID}`);
  });

  it("fires the PATCH match call with the picked lead id when a result is selected", async () => {
    setAgency(true);
    installFetch({ searchResults: [makeSearchResult({ id: 777 })] });
    const user = await renderAndExpand();

    const box = await screen.findByPlaceholderText("Search by name, phone, or email");
    await user.type(box, "ro");

    const result = await screen.findByText("Road Runner");
    await user.click(result);

    await waitFor(() => expect(matchCalls).toHaveLength(1));
    expect(matchCalls[0].url).toContain("/api/drilldown/jobs/9001/lead");
    expect(matchCalls[0].body).toEqual({ leadId: 777 });
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("surfaces the server error to the operator when the match call fails", async () => {
    setAgency(true);
    installFetch({
      searchResults: [makeSearchResult({ id: 777 })],
      matchOk: false,
      matchError: "Lead belongs to a different tenant",
    });
    const user = await renderAndExpand();

    const box = await screen.findByPlaceholderText("Search by name, phone, or email");
    await user.type(box, "ro");

    const result = await screen.findByText("Road Runner");
    await user.click(result);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Lead belongs to a different tenant"),
    );
  });

  it("renders the 'No matching leads.' empty state when the search returns no results", async () => {
    setAgency(true);
    installFetch({ searchResults: [] });
    const user = await renderAndExpand();

    const box = await screen.findByPlaceholderText("Search by name, phone, or email");
    await user.type(box, "zz");

    // The dropdown opens once the (empty) search resolves and shows the
    // empty-state copy rather than a stale list or a hidden dropdown.
    expect(await screen.findByText("No matching leads.")).toBeInTheDocument();
    // The empty array still counts as a completed search request.
    expect(searchCallUrls).toHaveLength(1);
  });

  it("shows the transient 'Searching…' indicator while a 2+ character request is in flight", async () => {
    setAgency(true);

    // First search resolves empty (which opens the dropdown); the second
    // search is left pending so the in-flight state stays observable.
    let searchCall = 0;
    vi.spyOn(global, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/drilldown/revenue-attributed")) {
          return { ok: true, status: 200, json: async () => [makeJob()] } as Response;
        }
        if (url.includes("/api/drilldown/leads/search")) {
          searchCall += 1;
          if (searchCall === 1) {
            return { ok: true, status: 200, json: async () => [] } as Response;
          }
          // Second request never settles, keeping the UI in the searching state.
          return await new Promise<Response>(() => {});
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      },
    );

    const user = await renderAndExpand();
    const box = await screen.findByPlaceholderText("Search by name, phone, or email");
    await user.type(box, "zz");

    // First request resolved empty -> dropdown is open with the empty state.
    await screen.findByText("No matching leads.");

    // Typing another character fires a fresh request; while it is in flight the
    // dropdown swaps the empty copy for the "Searching…" indicator.
    await user.type(box, "z");
    expect(await screen.findByText("Searching…")).toBeInTheDocument();
  });

  it("surfaces an error and clears the spinner when the search request itself fails", async () => {
    setAgency(true);
    installFetch({ searchOk: false });
    const user = await renderAndExpand();

    const box = await screen.findByPlaceholderText("Search by name, phone, or email");
    await user.type(box, "zz");

    // The failed search opens the dropdown with an explicit error rather than a
    // misleading "No matching leads." empty state.
    expect(
      await screen.findByText("Search failed. Please try again."),
    ).toBeInTheDocument();
    // The request fired exactly once and the in-flight indicator is gone.
    expect(searchCallUrls).toHaveLength(1);
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
    // No stale "No matching leads." copy is shown alongside the error.
    expect(screen.queryByText("No matching leads.")).not.toBeInTheDocument();
  });

  it("clears a previously rendered result list when a later search fails", async () => {
    setAgency(true);

    // First search succeeds with a result; the second search fails (non-OK).
    let searchCall = 0;
    vi.spyOn(global, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/drilldown/revenue-attributed")) {
          return { ok: true, status: 200, json: async () => [makeJob()] } as Response;
        }
        if (url.includes("/api/drilldown/leads/search")) {
          searchCall += 1;
          if (searchCall === 1) {
            return {
              ok: true,
              status: 200,
              json: async () => [makeSearchResult()],
            } as Response;
          }
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      },
    );

    const user = await renderAndExpand();
    const box = await screen.findByPlaceholderText("Search by name, phone, or email");

    // First search renders the result.
    await user.type(box, "ro");
    await screen.findByText("Road Runner");

    // A further keystroke fires a fresh search that fails.
    await user.type(box, "x");

    // The stale result is gone and the error is shown instead.
    await waitFor(() =>
      expect(screen.queryByText("Road Runner")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText("Search failed. Please try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
  });

  it("does not render the search box for a client (read-only) user", async () => {
    setAgency(false);
    installFetch();
    await renderAndExpand();

    // The read-only copy is shown instead of the agency controls.
    expect(
      await screen.findByText("Attribution edits are managed by your agency."),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Search by name, phone, or email"),
    ).not.toBeInTheDocument();
  });
});
