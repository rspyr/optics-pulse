// Coverage for the date-range picker wiring on the Agency God View
// (internal.tsx). The page owns a DateRangePicker whose preset/custom choice
// resolves to a concrete {startDate, endDate} window that is fed straight into
// useGetCrossTenantOverview. The header below the title echoes back the window
// the endpoint actually returned via `data.dateRange`.
//
// Two regressions this pins down:
//   1. Picking a preset (e.g. "Last 30 Days" / "Last Month") must change the
//      startDate/endDate the cross-tenant overview hook is called with — so the
//      data window genuinely follows the selector.
//   2. The header must render the active range from `data.dateRange` (the
//      endpoint's echo), formatted to a readable label, rather than whatever
//      the client picked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { resolvePreset } from "@/components/date-range-picker";

// Shared mutable holder the api-client mock writes to. `vi.hoisted` makes it
// available inside the (hoisted) vi.mock factory below as well as in the test
// body so we can read back the params the overview hook was called with and
// swap the response data per test.
const overviewState = vi.hoisted(() => ({
  lastParams: undefined as
    | { startDate?: string; endDate?: string; tenantId?: number }
    | undefined,
  data: undefined as
    | {
        dateRange: { startDate: string; endDate: string };
        tenants: unknown[];
        agencyAverages: unknown;
      }
    | undefined,
}));

// ─── Auth + api-client hooks ──────────────────────────────────────────────────

vi.mock("@/components/auth-context", () => ({
  useAuth: () => ({
    selectedTenantId: null,
    setSelectedTenantId: vi.fn(),
  }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { mockApiClientReactModule, makeApiClientHookStub } = await import(
    "@/test-utils/api-client-react-mocks"
  );
  return mockApiClientReactModule({
    // Capture the params on every call and hand back whatever data the active
    // test queued. isLoading stays false so the page renders past its skeleton.
    useGetCrossTenantOverview: ((params?: {
      startDate?: string;
      endDate?: string;
      tenantId?: number;
    }) => {
      overviewState.lastParams = params;
      return { ...makeApiClientHookStub(), data: overviewState.data };
    }) as unknown as typeof import("@workspace/api-client-react").useGetCrossTenantOverview,
    useListTenants: (() => ({
      ...makeApiClientHookStub(),
      data: [{ id: 42, name: "Acme", isActive: true }],
    })) as unknown as typeof import("@workspace/api-client-react").useListTenants,
  });
});

// The shipped DateRangePicker hangs its preset buttons inside a Radix Popover
// portal, which jsdom can't open via a click. Swap the popover primitives for
// passthroughs so the trigger AND the preset buttons render inline — the
// component's own preset→onChange wiring (the thing under test) is untouched.
vi.mock("@/components/ui/popover", async () => {
  const React = await import("react");
  return {
    Popover: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    PopoverTrigger: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    PopoverContent: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    PopoverAnchor: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

// The calendar (custom-range picker) isn't exercised here and drags in
// react-day-picker; stub it to a no-op so the passthrough popover stays light.
vi.mock("@/components/ui/calendar", () => ({
  Calendar: () => null,
}));

// Pulled in after the mocks so the page picks up the stubs.
import Internal from "../internal";

function renderInternal() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Internal />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  overviewState.lastParams = undefined;
  overviewState.data = undefined;
  // The page fires fetchSyncStatus() on mount; hand back an empty snapshot so
  // the unrelated fetch doesn't error in the test environment.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Internal — date picker drives the overview data window", () => {
  it("starts on 'This Month' and feeds that window to useGetCrossTenantOverview", async () => {
    renderInternal();

    const expected = resolvePreset("thisMonth");
    await waitFor(() => {
      expect(overviewState.lastParams).toEqual({
        startDate: expected.startDate,
        endDate: expected.endDate,
        tenantId: undefined,
      });
    });
  });

  it("choosing 'Last 30 Days' updates the startDate/endDate passed to the hook", async () => {
    const user = userEvent.setup();
    renderInternal();

    // Sanity: we begin on This Month.
    const thisMonth = resolvePreset("thisMonth");
    await waitFor(() => {
      expect(overviewState.lastParams?.startDate).toBe(thisMonth.startDate);
    });

    await user.click(screen.getByRole("button", { name: "Last 30 Days" }));

    const last30 = resolvePreset("last30");
    await waitFor(() => {
      expect(overviewState.lastParams).toEqual({
        startDate: last30.startDate,
        endDate: last30.endDate,
        tenantId: undefined,
      });
    });
    // The window genuinely moved off the default.
    expect(overviewState.lastParams?.startDate).not.toBe(thisMonth.startDate);
  });

  it("choosing 'Last Month' updates the startDate/endDate passed to the hook", async () => {
    const user = userEvent.setup();
    renderInternal();

    const thisMonth = resolvePreset("thisMonth");
    await waitFor(() => {
      expect(overviewState.lastParams?.startDate).toBe(thisMonth.startDate);
    });

    await user.click(screen.getByRole("button", { name: "Last Month" }));

    const lastMonth = resolvePreset("lastMonth");
    await waitFor(() => {
      expect(overviewState.lastParams).toEqual({
        startDate: lastMonth.startDate,
        endDate: lastMonth.endDate,
        tenantId: undefined,
      });
    });
  });

  it("renders the active range from data.dateRange in the header", async () => {
    overviewState.data = {
      dateRange: { startDate: "2026-03-01", endDate: "2026-03-31" },
      tenants: [],
      agencyAverages: {
        cpl: 0,
        roas: 0,
        bookingRate: 0,
        totalSpend: 0,
        totalRevenue: 0,
        totalLeads: 0,
      },
    };

    renderInternal();

    // The header echoes the endpoint's window formatted as "Mon D, YYYY",
    // independent of whatever preset the client currently has selected.
    await waitFor(() => {
      expect(
        screen.getByText(/Mar 1, 2026\s*–\s*Mar 31, 2026/),
      ).toBeInTheDocument();
    });
  });
});
