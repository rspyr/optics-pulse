// Regression coverage for the new `manual` match-level status (Task #580).
//
// The `manual` flip is invoked from operator-action server paths
// (field-mapping rule save, per-lead funnel override, rule-scope re-derive
// fan-out, and route funnel rule backfill). On the marketing-os side, three
// contracts have to hold:
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
  // Shared helper auto-stubs every other generated hook with a safe
  // no-result default, so adding new hooks to the client doesn't require
  // touching this factory.
  const { mockApiClientReactModule } = await import(
    "@/test-utils/api-client-react-mocks"
  );
  type ApiMod = typeof import("@workspace/api-client-react");
  return mockApiClientReactModule({
    useListAttributionEvents: useListAttributionEventsMock as unknown as ApiMod["useListAttributionEvents"],
    useGetAttributionEvent: useGetAttributionEventMock as unknown as ApiMod["useGetAttributionEvent"],
    useGetAttributionEventFacets: useGetAttributionEventFacetsMock as unknown as ApiMod["useGetAttributionEventFacets"],
    useGetLeadInvoice: useGetLeadInvoiceMock as unknown as ApiMod["useGetLeadInvoice"],
  });
});

vi.mock("@/hooks/use-tenant-filter", async () => {
  const { mockUseTenantFilterModule, makeTenantFilterStub } = await import(
    "@/test-utils/use-tenant-filter-mocks"
  );
  return mockUseTenantFilterModule({
    useTenantFilter: () =>
      makeTenantFilterStub({
        tenants: [{ id: 42, name: "Acme" }],
        localTenantId: 42,
        effectiveTenantId: 42,
      }),
  });
});

vi.mock("@/contexts/lead-notification-context", async () => {
  const { mockLeadNotificationModule } = await import("@/test-utils/lead-notification-mocks");
  return mockLeadNotificationModule();
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/rule-rederive-subscription", () => ({
  subscribeRederiveOnce: () => () => {},
}));

// Mock `@/components/ui/select` so the dropdown renders as a real <select>
// element. That lets userEvent.selectOptions drive the filter and verify
// that `useListAttributionEvents` is recalled with `matchLevel=manual`.
vi.mock("@/components/ui/select", async () => {
  const { mockUiSelectAsNative } = await import(
    "@/test-utils/ui-select-mocks"
  );
  return mockUiSelectAsNative();
});

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

  // Task #584: each flip site writes a distinct manualSource
  // stamp, and the event sheet has to surface that stamp as a human-readable
  // "Resolved by …" line with a deep-link back to the action. These three
  // assertions lock in the wire-up between the persisted stamp and the
  // rendered link target.
  it("renders 'Resolved by field-mapping rule #<id>' with a deep-link when manualSource = 'field_mapping_rule:<id>' (Task #584)", async () => {
    const ev = makeEvent({ manualSource: "field_mapping_rule:123" });
    useGetAttributionEventMock.mockReturnValue({
      data: { event: ev, matchedJob: null, matchedLead: null },
    });
    renderPage();
    const row = await screen.findByText("form fill");
    fireEvent.click(row.closest("tr") as HTMLTableRowElement);
    const link = await screen.findByTestId("manual-source-rule-link");
    expect(link).toHaveTextContent("field-mapping rule #123");
    expect(link.getAttribute("href")).toContain("ruleId=123");
  });

  it("renders 'Resolved by per-lead funnel override on lead #<id>' with a deep-link when manualSource = 'funnel_override:lead/<leadId>' (Task #584)", async () => {
    const ev = makeEvent({ manualSource: "funnel_override:lead/555" });
    useGetAttributionEventMock.mockReturnValue({
      data: { event: ev, matchedJob: null, matchedLead: null },
    });
    renderPage();
    const row = await screen.findByText("form fill");
    fireEvent.click(row.closest("tr") as HTMLTableRowElement);
    const link = await screen.findByTestId("manual-source-override-link");
    expect(link).toHaveTextContent("lead #555");
    expect(link.getAttribute("href")).toContain("leadId=555");
  });

  it("renders the rule-scope fallback (no link) when manualSource = 'field_mapping_rule:scope' from the historical re-derive fan-out (Task #584)", async () => {
    const ev = makeEvent({ manualSource: "field_mapping_rule:scope" });
    useGetAttributionEventMock.mockReturnValue({
      data: { event: ev, matchedJob: null, matchedLead: null },
    });
    renderPage();
    const row = await screen.findByText("form fill");
    fireEvent.click(row.closest("tr") as HTMLTableRowElement);
    expect(await screen.findByTestId("manual-source-rule-scope")).toBeInTheDocument();
    expect(screen.queryByTestId("manual-source-rule-link")).not.toBeInTheDocument();
  });

  it("renders a route-rule source line when manualSource = 'route_funnel_rule:<path>'", async () => {
    const ev = makeEvent({ manualSource: "route_funnel_rule:/summer-relief-plan" });
    useGetAttributionEventMock.mockReturnValue({
      data: { event: ev, matchedJob: null, matchedLead: null },
    });
    renderPage();
    const row = await screen.findByText("form fill");
    fireEvent.click(row.closest("tr") as HTMLTableRowElement);
    const line = await screen.findByTestId("manual-source-route-rule");
    expect(line).toHaveTextContent("route rule /summer-relief-plan");
  });

  it("renders a legacy fallback line when manualSource is null on a `manual` row (pre-task #584 events)", async () => {
    const ev = makeEvent({ manualSource: null });
    useGetAttributionEventMock.mockReturnValue({
      data: { event: ev, matchedJob: null, matchedLead: null },
    });
    renderPage();
    const row = await screen.findByText("form fill");
    fireEvent.click(row.closest("tr") as HTMLTableRowElement);
    expect(await screen.findByTestId("manual-source-legacy")).toBeInTheDocument();
  });
});
