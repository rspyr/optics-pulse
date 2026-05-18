import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, waitFor, within } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AuthProvider, useAuth } from "@/components/auth-context";

// Mock the generated api-client-react hooks used by /internal and /attribution.
// We only need the bits each page reads to render its tenant filter header —
// every other data path can be a stub. This is what the dropdown rendering
// actually depends on; the rest of the page can stay empty.
const tenantList = [
  { id: 11, name: "Acme", isActive: true },
  { id: 22, name: "Beta", isActive: true },
];

vi.mock("@workspace/api-client-react", () => {
  const noop = () => undefined;
  return {
    useGetAdminDashboardStats: () => ({ data: undefined, isLoading: false }),
    useListLeads: () => ({ data: undefined, isLoading: false }),
    useGetReconciliationStatus: () => ({ data: undefined, refetch: vi.fn() }),
    useRunReconciliation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useListTenants: () => ({ data: tenantList }),
    useListAttributionEvents: () => ({ data: undefined }),
    useGetAttributionEvent: () => ({ data: undefined }),
    getListAttributionEventsQueryKey: noop,
    getGetAttributionEventQueryKey: noop,
  };
});

import Internal from "../internal";
import Attribution from "../attribution";

const STORAGE_KEY = "agencyGodView.tenantId";

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/auth/me")) {
      return {
        ok: true,
        json: async () => ({
          id: 1,
          email: "admin@agency.test",
          name: "Admin",
          role: "super_admin",
          tenantId: null,
          tenantName: null,
          leaderboardConfig: null,
        }),
      } as Response;
    }
    if (url.endsWith("/api/tenants") || url.endsWith("/tenants")) {
      return {
        ok: true,
        json: async () => tenantList.map((t) => ({ id: t.id, name: t.name })),
      } as Response;
    }
    // Default: harmless empty response so unrelated fetches (sync-status,
    // subdomain-rule suggestions, etc.) don't blow up the tests.
    return { ok: true, json: async () => ({}) } as Response;
  });
}

// AuthContext's initial selectedTenantId is read from localStorage during the
// very first render. Tests that need a specific starting selection must seed
// storage *before* the AuthProvider mounts.
function renderWithProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
}

// Probe lets the test reach into AuthContext to flip the shared selection
// programmatically — same code path the page-level dropdowns invoke via
// onValueChange.
function AuthProbe({ onReady }: { onReady: (a: ReturnType<typeof useAuth>) => void }) {
  const auth = useAuth();
  React.useEffect(() => {
    onReady(auth);
  });
  return null;
}

function getInternalTrigger(): HTMLElement {
  // The /internal tenant picker is the only Select whose initial trigger text
  // matches one of the tenant labels — "All Tenants" or a tenant name. Grab
  // it via the surrounding header layout.
  const triggers = Array.from(
    document.querySelectorAll<HTMLElement>('button[role="combobox"]'),
  );
  const match = triggers.find((t) => /All Tenants|Acme|Beta/.test(t.textContent ?? ""));
  if (!match) {
    throw new Error(
      "Could not find tenant-picker trigger; combobox triggers were: " +
        triggers.map((t) => JSON.stringify(t.textContent)).join(", "),
    );
  }
  return match;
}

describe("Tenant filter dropdown UI — trigger label tracks the shared selection", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", makeFetchMock());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("/internal dropdown trigger renders 'All Tenants' when nothing is selected and the tenant's name when it is", async () => {
    // Seed an explicit "All Tenants" choice so useTenantFilter doesn't
    // auto-pick the first tenant on first visit.
    window.localStorage.setItem(STORAGE_KEY, "all");

    let auth: ReturnType<typeof useAuth> | null = null;
    renderWithProviders(
      <>
        <AuthProbe onReady={(a) => { auth = a; }} />
        <Internal />
      </>,
    );

    await waitFor(() => expect(auth?.user?.role).toBe("super_admin"));

    const trigger = getInternalTrigger();
    expect(trigger.textContent).toContain("All Tenants");

    act(() => { auth!.setSelectedTenantId(22); });

    await waitFor(() => {
      expect(getInternalTrigger().textContent).toContain("Beta");
    });
    expect(getInternalTrigger().textContent).not.toContain("All Tenants");

    act(() => { auth!.setSelectedTenantId(null); });
    await waitFor(() => {
      expect(getInternalTrigger().textContent).toContain("All Tenants");
    });
  });

  it("/attribution dropdown trigger renders 'All Tenants' when nothing is selected and the tenant's name when it is", async () => {
    window.localStorage.setItem(STORAGE_KEY, "all");

    let auth: ReturnType<typeof useAuth> | null = null;
    renderWithProviders(
      <>
        <AuthProbe onReady={(a) => { auth = a; }} />
        <Attribution />
      </>,
    );

    await waitFor(() => expect(auth?.user?.role).toBe("super_admin"));

    // The Attribution picker only mounts once useTenantFilter has fetched
    // its tenant list (gated on `isAgency && tenants.length > 0`).
    await waitFor(() => {
      const trigger = getInternalTrigger();
      expect(trigger.textContent).toContain("All Tenants");
    });

    act(() => { auth!.setSelectedTenantId(11); });
    await waitFor(() => {
      expect(getInternalTrigger().textContent).toContain("Acme");
    });

    act(() => { auth!.setSelectedTenantId(22); });
    await waitFor(() => {
      expect(getInternalTrigger().textContent).toContain("Beta");
    });
  });

  it("picking a value in one dropdown is reflected in the other's trigger label without remounting either trigger", async () => {
    window.localStorage.setItem(STORAGE_KEY, "all");

    let auth: ReturnType<typeof useAuth> | null = null;
    // Wrap each page in a labelled container so we can disambiguate the two
    // triggers and assert the *same DOM nodes* survive a selection change
    // (i.e. no remount).
    renderWithProviders(
      <>
        <AuthProbe onReady={(a) => { auth = a; }} />
        <div data-testid="internal-host"><Internal /></div>
        <div data-testid="attribution-host"><Attribution /></div>
      </>,
    );

    await waitFor(() => expect(auth?.user?.role).toBe("super_admin"));

    const internalHost = screen.getByTestId("internal-host");
    const attributionHost = screen.getByTestId("attribution-host");

    // Each page has more than one combobox (event-type filter, etc.). The
    // tenant picker is the one whose visible label is the agency-wide
    // sentinel or one of the seeded tenant names.
    const tenantPickerIn = (host: HTMLElement) => {
      const triggers = within(host).queryAllByRole("combobox");
      const match = triggers.find((t) =>
        /All Tenants|Acme|Beta/.test(t.textContent ?? ""),
      );
      if (!match) {
        throw new Error(
          `No tenant-picker combobox in ${host.dataset.testid}; saw: ` +
            triggers.map((t) => JSON.stringify(t.textContent)).join(", "),
        );
      }
      return match;
    };

    // Both triggers should be visible and showing "All Tenants".
    await waitFor(() => {
      expect(tenantPickerIn(internalHost).textContent).toContain("All Tenants");
      expect(tenantPickerIn(attributionHost).textContent).toContain("All Tenants");
    });

    const internalTriggerBefore = tenantPickerIn(internalHost);
    const attributionTriggerBefore = tenantPickerIn(attributionHost);

    // Pick "Beta" — same code path the dropdown's onValueChange invokes.
    act(() => { auth!.setSelectedTenantId(22); });

    await waitFor(() => {
      expect(tenantPickerIn(internalHost).textContent).toContain("Beta");
      expect(tenantPickerIn(attributionHost).textContent).toContain("Beta");
    });

    // Same DOM node — the trigger updated in place, no remount.
    expect(tenantPickerIn(internalHost)).toBe(internalTriggerBefore);
    expect(tenantPickerIn(attributionHost)).toBe(attributionTriggerBefore);

    // Flip again to make sure cross-page propagation isn't a one-shot.
    act(() => { auth!.setSelectedTenantId(11); });
    await waitFor(() => {
      expect(tenantPickerIn(internalHost).textContent).toContain("Acme");
      expect(tenantPickerIn(attributionHost).textContent).toContain("Acme");
    });

    // And back to "All Tenants" — both triggers must reflect the agency-wide
    // sentinel, not stale tenant labels.
    act(() => { auth!.setSelectedTenantId(null); });
    await waitFor(() => {
      expect(tenantPickerIn(internalHost).textContent).toContain("All Tenants");
      expect(tenantPickerIn(attributionHost).textContent).toContain("All Tenants");
    });
  });
});
