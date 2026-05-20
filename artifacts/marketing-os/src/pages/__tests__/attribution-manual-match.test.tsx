// Regression coverage for the new `manual` match-level status (Task #580).
//
// The `manual` flip is invoked from three operator-action server paths
// (field-mapping rule save, per-lead funnel override, rule-scope re-derive
// fan-out). On the marketing-os side, three contracts have to hold:
//
//   1. The MATCH badge column renders `MANUAL` for `matchLevel === "manual"`
//      so operators can see at-a-glance what they resolved by hand.
//   2. Selecting "Manual" in the match-level filter submits
//      `matchLevel=manual` to the events list endpoint.
//   3. The "Why unmatched?" panel must NOT render when `matchLevel === "manual"`
//      — the operator already resolved it; keeping the panel visible would
//      invite them to re-map the same fill.
//
// These three together are what the unit-level service test
// (`mark-event-manually-matched.test.ts`) and the route tests can't catch:
// the wire-up between the badge string, the filter dropdown, and the sheet's
// conditional rendering.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { useListAttributionEventsMock, useGetAttributionEventMock, useGetAttributionEventFacetsMock, useGetLeadInvoiceMock } = vi.hoisted(() => ({
  useListAttributionEventsMock: vi.fn(),
  useGetAttributionEventMock: vi.fn(),
  useGetAttributionEventFacetsMock: vi.fn(),
  useGetLeadInvoiceMock: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<typeof import("@workspace/api-client-react")>(
    "@workspace/api-client-react",
  );
  return {
    ...actual,
    useListAttributionEvents: useListAttributionEventsMock,
    useGetAttributionEvent: useGetAttributionEventMock,
    useGetAttributionEventFacets: useGetAttributionEventFacetsMock,
    useGetLeadInvoice: useGetLeadInvoiceMock,
  };
});

vi.mock("@/hooks/use-tenant-filter", () => ({
  useTenantFilter: () => ({
    tenants: [{ id: 42, name: "Acme" }],
    localTenantId: 42,
    effectiveTenantId: 42,
    setSelectedTenantId: vi.fn(),
    isAgency: false,
    tenantsLoading: false,
  }),
}));

vi.mock("@/contexts/lead-notification-context", () => ({
  useOptionalLeadNotification: () => null,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/rule-rederive-subscription", () => ({
  subscribeRederiveOnce: () => () => {},
}));

// Mock `@/components/ui/select` so the dropdown renders as a real <select>
// element. That lets userEvent.selectOptions drive the filter and verify
// that `useListAttributionEvents` is recalled with `matchLevel=manual`.
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange?: (v: string) => void; children: React.ReactNode }) => (
    <select
      data-testid="ui-select"
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

// The Sheet primitive normally portals into document.body and is only mounted
// when `open` is true. For the panel-gating assertion we need its children
// rendered inline whenever `open` is truthy, so swap it for a tiny inline shim.
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="event-sheet">{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// `UnmatchedFieldsPanel` issues its own GET on mount; replace with a marker so
// the test can simply assert presence/absence rather than mocking fetch for it.
vi.mock("../unmatched-fields-panel", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../unmatched-fields-panel");
  return {
    ...actual,
    UnmatchedFieldsPanel: () => <div data-testid="unmatched-fields-panel" />,
    usePrefetchScopedRules: () => {},
    formatLastAttempted: () => "",
  };
});

vi.mock("@/components/pending-rederive-leads-sheet", () => ({
  PendingRederiveLeadsSheet: () => null,
}));

import Attribution from "../attribution";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 7001,
    tenantId: 42,
    eventType: "form_fill",
    pageUrl: "https://acme.com/contact",
    formId: "contact-form",
    formName: "Contact",
    matchLevel: "manual",
    matchConfidence: 1,
    createdAt: new Date("2026-05-01T12:00:00Z").toISOString(),
    submittedAt: null,
    source: "google",
    funnel: null,
    formType: null,
    gclid: null,
    hashedPhone: null,
    externalId: null,
    fieldNames: ["field_3"],
    formFields: { field_3: "555" },
    unmatchedReason: null,
    detectedMappings: null,
    createdLeadId: null,
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Attribution />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useListAttributionEventsMock.mockReset();
  useGetAttributionEventMock.mockReset();
  useGetAttributionEventFacetsMock.mockReset();
  useGetLeadInvoiceMock.mockReset();
  useListAttributionEventsMock.mockReturnValue({ data: { events: [makeEvent()], total: 1 } });
  useGetAttributionEventMock.mockReturnValue({ data: undefined });
  useGetAttributionEventFacetsMock.mockReturnValue({ data: { sources: [], funnels: [], subdomainRules: [] } });
  useGetLeadInvoiceMock.mockReturnValue({ data: null, isLoading: false, error: null });
  vi.spyOn(global, "fetch").mockImplementation(async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        rules: [],
        suggestions: [],
        hiddenSubdomains: [],
        funnelTypes: [],
        leads: [],
      }),
    }) as Response,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Attribution page — `manual` match-level (Task #580)", () => {
  it("renders the MANUAL badge in the events table for an event whose matchLevel is 'manual'", async () => {
    renderPage();
    // There may be more than one MANUAL badge on the page (table cell + any
    // legend); the contract is just that at least one exists for the row.
    const badges = await screen.findAllByText("MANUAL");
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("selecting 'Manual' in the match-level filter submits matchLevel='manual' to the events list endpoint", async () => {
    const user = userEvent.setup();
    renderPage();

    // Find the <option value="manual">Manual</option> rendered by our Select
    // mock; its parent <select> is the match-level dropdown.
    const manualOption = await screen.findByRole("option", { name: "Manual" });
    const select = manualOption.closest("select");
    expect(select).not.toBeNull();

    useListAttributionEventsMock.mockClear();
    await user.selectOptions(select as HTMLSelectElement, "manual");

    await waitFor(() => {
      const calledWithManual = useListAttributionEventsMock.mock.calls.some(
        ([params]) => (params as { matchLevel?: string } | undefined)?.matchLevel === "manual",
      );
      expect(calledWithManual).toBe(true);
    });
  });

  it("does NOT render the 'Why unmatched?' panel inside the event sheet when matchLevel === 'manual'", async () => {
    const manualEvent = makeEvent();
    useGetAttributionEventMock.mockReturnValue({
      data: { event: manualEvent, matchedJob: null, matchedLead: null },
    });
    renderPage();

    // Open the sheet by clicking the row.
    const row = await screen.findByText("form fill");
    fireEvent.click(row.closest("tr") as HTMLTableRowElement);

    // Sheet is now open — assert the panel is absent.
    await screen.findByTestId("event-sheet");
    expect(screen.queryByTestId("unmatched-fields-panel")).not.toBeInTheDocument();
  });

});
