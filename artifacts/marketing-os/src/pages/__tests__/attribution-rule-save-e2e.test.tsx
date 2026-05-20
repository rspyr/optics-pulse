// End-to-end smoke test for the operator's "save a rule from the Why
// unmatched? panel and watch the row flip" handshake (Task #585).
//
// The unit + route + UI tests added in Task #580 each cover one slice of this
// flow in isolation — the route flips the DB column, the panel posts the
// correct body, the badge component renders MANUAL for `matchLevel: "manual"`.
// None of them prove the *full* handshake works end-to-end:
//
//   1. Operator opens an UNMATCHED event on the Attribution page.
//   2. Expands the "Why unmatched?" panel and saves a field-mapping rule.
//   3. The save POST carries `attributionEventId` so the server can flip the
//      event to `matchLevel = "manual"`.
//   4. The list query is invalidated (in production: by an SSE-driven refetch;
//      here: by an explicit `invalidateQueries` standing in for the SSE
//      channel, per the task's "or stubs the SSE channel" option).
//   5. The row's badge re-renders from UNMATCHED to MANUAL on the same screen.
//
// This is exactly the handshake that broke in the original incident. Driving
// it through the real `useListAttributionEvents` query (with a global fetch
// mock backing it) is what makes this a smoke test rather than a unit test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getListAttributionEventsQueryKey, getGetAttributionEventQueryKey } from "@workspace/api-client-react";

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
  subscribeBulkRederive: () => ({ onSaveSucceeded: () => {}, onSaveFailed: () => {}, finalize: () => {} }),
}));

// Render the Select dropdown as a real <select> so userEvent can interact with
// the "Map field_3 to" combobox. (Radix Select uses portals + pointer events
// that jsdom doesn't model well.)
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

// Render Sheet children inline when `open` is true so we can drive the event
// detail panel without portal/animation timing.
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="event-sheet">{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/pending-rederive-leads-sheet", () => ({
  PendingRederiveLeadsSheet: () => null,
}));

// We're driving the *real* unmatched-fields-panel for this E2E so don't mock it.
// Just stub the lead-invoice hook used by the sheet's invoice section.
vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<typeof import("@workspace/api-client-react")>(
    "@workspace/api-client-react",
  );
  return {
    ...actual,
    useGetLeadInvoice: () => ({ data: null, isLoading: false, error: null }),
  };
});

import Attribution from "../attribution";

function makeUnmatchedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 9001,
    tenantId: 42,
    eventType: "form_fill",
    pageUrl: "https://acme.com/contact",
    formId: "contact-form-1",
    formName: "Contact",
    matchLevel: "unmatched",
    matchConfidence: 0,
    createdAt: new Date("2026-05-01T12:00:00Z").toISOString(),
    submittedAt: null,
    source: "google",
    funnel: null,
    formType: null,
    gclid: null,
    hashedPhone: null,
    externalId: null,
    fieldNames: ["field_3"],
    formFields: { field_3: "555-1212" },
    unmatchedReason: "no_match",
    detectedMappings: null,
    createdLeadId: null,
    ...overrides,
  };
}

// Mutable server-side state. The fetch mock reads/writes through this so that
// after the POST flips the event to MANUAL, the next list refetch returns the
// new badge — same way a real SSE-driven refetch would land it in the UI.
let eventsState: ReturnType<typeof makeUnmatchedEvent>[] = [];
let postedRuleBodies: Array<Record<string, unknown>> = [];

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function installFetchMock() {
  return vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = ((init?.method as string | undefined) || "GET").toUpperCase();

    // --- POST: save a field-mapping rule. This is the operator action under
    // test. Record the body so we can assert `attributionEventId` is set, and
    // mutate `eventsState` to mirror what the server would do (flip the row
    // to matchLevel="manual"). The "SSE refresh" is stubbed by the test
    // explicitly invalidating the list query after the POST resolves.
    if (url.includes("/api/field-mapping-rules") && method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      postedRuleBodies.push(body);
      if (typeof body.attributionEventId === "number") {
        eventsState = eventsState.map((e) =>
          e.id === body.attributionEventId
            ? { ...e, matchLevel: "manual", matchConfidence: 1, unmatchedReason: null }
            : e,
        );
      }
      return jsonResponse({ rule: { id: 7777 }, updated: false, leadFunnelChanged: false, eventDetectionRecomputed: true });
    }

    // --- GET: list of attribution events (drives the row badge).
    if (url.includes("/api/attribution/events") && !url.includes("/facets") && !url.match(/\/api\/attribution\/events\/\d/)) {
      return jsonResponse({ events: eventsState, total: eventsState.length });
    }

    // --- GET: single event detail (drives the open sheet).
    const detailMatch = url.match(/\/api\/attribution\/events\/(\d+)/);
    if (detailMatch && method === "GET") {
      const id = Number(detailMatch[1]);
      const ev = eventsState.find((e) => e.id === id);
      if (!ev) return jsonResponse({}, { status: 404 });
      return jsonResponse({ event: ev, matchedJob: null, matchedLead: null });
    }

    // --- GET: facets (filters dropdown data).
    if (url.includes("/api/attribution/events/facets")) {
      return jsonResponse({ sources: [], funnels: [], subdomainRules: [] });
    }

    // --- Everything else (subdomain rules, suggestions, scoped rules,
    // funnel-types, funnel-aliases, leads, etc.) — return empty defaults so
    // the page renders without unrelated network errors.
    return jsonResponse({
      rules: [],
      suggestions: {},
      hiddenSubdomains: [],
      funnelTypes: [],
      leads: [],
    });
  });
}

let queryClient: QueryClient;

function renderPage() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Attribution />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  eventsState = [makeUnmatchedEvent()];
  postedRuleBodies = [];
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Attribution end-to-end: saved rule flips the live event to MANUAL (Task #585)", () => {
  it("driving the full operator action — open unmatched event → save mapping → list refetch — flips the row badge from UNMATCHED to MANUAL", async () => {
    const user = userEvent.setup();
    renderPage();

    // Initial render: the row shows UNMATCHED.
    expect(await screen.findByText("UNMATCHED")).toBeInTheDocument();
    expect(screen.queryByText("MANUAL")).not.toBeInTheDocument();

    // Open the event sheet by clicking the row.
    const unmatchedBadge = screen.getByText("UNMATCHED");
    const row = unmatchedBadge.closest("tr") as HTMLTableRowElement;
    expect(row).not.toBeNull();
    fireEvent.click(row);
    await screen.findByTestId("event-sheet");

    // Expand the "Why unmatched?" panel — the real UnmatchedFieldsPanel mounts
    // because matchLevel === "unmatched".
    await user.click(await screen.findByRole("button", { name: /Why unmatched\?/ }));

    // Pick a target for field_3 and click Save. This is the POST that the
    // server uses to flip the event to MANUAL.
    const mapSelect = await screen.findByRole("combobox", { name: "Map field_3 to" });
    await user.selectOptions(mapSelect, "phone");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    // The save POST must carry `attributionEventId` — that's the field the
    // server keys off of in `markEventManuallyMatched`. Without it the row
    // would never flip, which is exactly the regression we're guarding.
    await waitFor(() => {
      expect(postedRuleBodies.length).toBeGreaterThan(0);
    });
    const lastBody = postedRuleBodies[postedRuleBodies.length - 1];
    expect(lastBody).toMatchObject({
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      fieldName: "field_3",
      mapsTo: "phone",
      attributionEventId: 9001,
    });

    // Stub the SSE-driven refetch the way the live tenant socket room would —
    // an invalidation of the list query forces useListAttributionEvents to
    // re-call our fetch mock, which now reads `matchLevel: "manual"` out of
    // the mutated `eventsState`.
    await act(async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListAttributionEventsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetAttributionEventQueryKey(9001) }),
        queryClient.invalidateQueries({ queryKey: ["attribution-event", 9001] }),
      ]);
    });

    // The row's badge has flipped from UNMATCHED to MANUAL on the same screen.
    await waitFor(() => {
      expect(screen.queryByText("UNMATCHED")).not.toBeInTheDocument();
    });
    const manualBadges = await screen.findAllByText("MANUAL");
    expect(manualBadges.length).toBeGreaterThanOrEqual(1);
  });
});
