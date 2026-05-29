// Component coverage for the agency-only lead-source editor in
// `AgencyControls` on the Revenue Attributed page (Task #677).
//
// The lead-matching typeahead in the same block is covered separately
// (Task #673). This file locks in the *source-correction* flow, all of
// which is UI wiring the route tests can't see:
//
//   1. The pencil/edit affordance only appears when the lead's ORIGINAL
//      source is "Unknown" (the `canEditSource` guard). When the original
//      source is known, the pencil is hidden and the "editable only when
//      original source is Unknown" hint is shown instead.
//   2. Opening the editor loads the canonical source list, and choosing a
//      source + saving fires a PATCH to `/api/leads-hub/<id>/source` with
//      the chosen value and shows a success toast.
//   3. A rejected save surfaces the server error message to the operator
//      (via a toast) rather than failing silently.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

// The shipped source picker is Radix's portal-driven Select, which jsdom
// can't model. Swap in the native-<select> shim so we can drive the choice
// via fireEvent.change against the combobox.
vi.mock("@/components/ui/select", async () => {
  const { mockUiSelectAsNative } = await import("@/test-utils/ui-select-mocks");
  return mockUiSelectAsNative();
});

vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

import RevenueAttributed from "../revenue-attributed";
import { makeTenantFilterStub } from "@/test-utils/use-tenant-filter-mocks";
import { makeAuthStub } from "@/test-utils/auth-context-mocks";

const TENANT_ID = 42;

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    id: 555,
    firstName: "Road",
    lastName: "Runner",
    source: "Unknown",
    originalSource: "Unknown",
    status: "new",
    hubStatus: null,
    ...overrides,
  };
}

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
    lead: makeLead(),
    ...overrides,
  };
}

type FetchHandlers = {
  job?: Record<string, unknown>;
  sources?: string[];
  saveOk?: boolean;
  saveError?: string;
};

let sourcePatchCalls: Array<{ url: string; body: unknown }> = [];

function installFetch(handlers: FetchHandlers = {}) {
  const {
    job = makeJob(),
    sources = ["google", "facebook", "referral"],
    saveOk = true,
    saveError = "Source is not in the canonical list",
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
          headers: { get: () => null },
          json: async () => [job],
        } as unknown as Response;
      }

      // Canonical source list (loaded when the editor opens)
      if (url.includes("/api/leads-hub/canonical-sources")) {
        return { ok: true, status: 200, json: async () => ({ sources }) } as Response;
      }

      // PATCH lead source
      if (/\/api\/leads-hub\/\d+\/source$/.test(url) && method === "PATCH") {
        sourcePatchCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
        if (!saveOk) {
          return {
            ok: false,
            status: 422,
            json: async () => ({ error: saveError }),
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

// Render the page and expand the single job row so AgencyControls is mounted.
async function renderAndExpand() {
  const user = userEvent.setup();
  render(<RevenueAttributed />);
  const customerCell = await screen.findByText("Wile E. Coyote");
  await user.click(customerCell.closest("tr") as HTMLTableRowElement);
  return user;
}

beforeEach(() => {
  sourcePatchCalls = [];
  useTenantFilterMock.mockReset();
  useAuthMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Revenue Attributed — lead source editor (Task #677)", () => {
  it("shows the edit affordance only when the lead's original source is Unknown", async () => {
    setAgency(true);
    installFetch({ job: makeJob({ lead: makeLead({ originalSource: "Unknown" }) }) });
    await renderAndExpand();

    expect(
      await screen.findByTitle("Edit source"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Source editable only when original source is Unknown."),
    ).not.toBeInTheDocument();
  });

  it("hides the edit affordance when the original source is known", async () => {
    setAgency(true);
    installFetch({
      job: makeJob({ lead: makeLead({ source: "google", originalSource: "google" }) }),
    });
    await renderAndExpand();

    // The read-only hint appears (proves the source section rendered) but the
    // pencil does not.
    expect(
      await screen.findByText("Source editable only when original source is Unknown."),
    ).toBeInTheDocument();
    expect(screen.queryByTitle("Edit source")).not.toBeInTheDocument();
  });

  it("PATCHes the chosen source and shows a success toast on save", async () => {
    setAgency(true);
    installFetch({ sources: ["google", "facebook", "referral"] });
    const user = await renderAndExpand();

    await user.click(await screen.findByTitle("Edit source"));

    // The canonical sources load into the native-<select> shim. The page has
    // other selects (filters), so scope to the one holding the source options.
    const sourceOption = await screen.findByRole("option", { name: "facebook" });
    const combobox = sourceOption.closest("select") as HTMLSelectElement;
    fireEvent.change(combobox, { target: { value: "facebook" } });

    // Save is the first (enabled) button next to the combobox.
    const editor = combobox.parentElement as HTMLElement;
    const [saveButton] = within(editor).getAllByRole("button");
    await user.click(saveButton);

    await waitFor(() => expect(sourcePatchCalls).toHaveLength(1));
    expect(sourcePatchCalls[0].url).toContain("/api/leads-hub/555/source");
    expect(sourcePatchCalls[0].body).toEqual({ source: "facebook" });
    expect(toastSuccessMock).toHaveBeenCalledWith("Lead source updated");
  });

  it("surfaces the server error to the operator when the save is rejected", async () => {
    setAgency(true);
    installFetch({
      saveOk: false,
      saveError: "Source is not in the canonical list",
    });
    const user = await renderAndExpand();

    await user.click(await screen.findByTitle("Edit source"));

    const sourceOption = await screen.findByRole("option", { name: "google" });
    const combobox = sourceOption.closest("select") as HTMLSelectElement;
    fireEvent.change(combobox, { target: { value: "google" } });

    const editor = combobox.parentElement as HTMLElement;
    const [saveButton] = within(editor).getAllByRole("button");
    await user.click(saveButton);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Source is not in the canonical list"),
    );
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });
});
