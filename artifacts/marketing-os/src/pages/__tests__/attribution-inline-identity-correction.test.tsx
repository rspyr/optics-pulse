import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { InlineIdentityCorrection } from "../attribution";
import {
  getListAttributionEventsQueryKey,
  getGetAttributionEventQueryKey,
} from "@workspace/api-client-react";
import type { AttributionEvent } from "@workspace/api-client-react";

function makeEvent(overrides: Partial<AttributionEvent> = {}): AttributionEvent {
  return {
    id: 42,
    resolvedLeadSource: "Google",
    resolvedFunnel: "Lead Magnet",
    utmSource: "google",
    referrer: null,
    detectedMappings: null,
    formFields: null,
    ...overrides,
  } as unknown as AttributionEvent;
}

type FetchHandler = (url: string, init?: RequestInit) => unknown;

function makeFetchMock(handlers: Array<{ match: string; method?: string; handler: FetchHandler; ok?: boolean }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const method = (init?.method ?? "GET").toUpperCase();
    for (const h of handlers) {
      if (!u.includes(h.match)) continue;
      if (h.method && h.method.toUpperCase() !== method) continue;
      const data = h.handler(u, init);
      return { ok: h.ok ?? true, json: async () => data } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  return { mock, calls };
}

function findCallWithQueryKey(
  spy: ReturnType<typeof vi.spyOn>,
  expectedKey: readonly unknown[],
) {
  return spy.mock.calls.find(([arg]) => {
    const key = (arg as { queryKey?: unknown[] } | undefined)?.queryKey;
    if (!Array.isArray(key) || key.length !== expectedKey.length) return false;
    return key.every((v, i) => Object.is(v, expectedKey[i]));
  });
}

describe("InlineIdentityCorrection — Task #549 funnel scope & override", () => {
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateSpy.mockRestore();
    queryClient.clear();
  });

  function renderComp(
    event: AttributionEvent,
    matchedLead?: { id: number; firstName?: string; lastName?: string; funnelOverriddenAt?: string | null } | null,
  ) {
    return render(
      <QueryClientProvider client={queryClient}>
        <InlineIdentityCorrection tenantId={1} event={event} matchedLead={matchedLead ?? null} />
      </QueryClientProvider>,
    );
  }

  it("Source save still invalidates all three query keys", async () => {
    const { mock } = makeFetchMock([
      { match: "/api/funnel-types", handler: () => ({ funnelTypes: [{ id: 7, name: "Lead Magnet" }] }) },
      { match: "/api/lead-source-aliases", handler: () => ({ aliases: [{ canonicalName: "Google" }, { canonicalName: "Facebook" }] }) },
      { match: "/api/lead-source-aliases", method: "POST", handler: () => ({ updatedEventCount: 0, updatedLeadCount: 0 }) },
    ]);
    vi.stubGlobal("fetch", mock);

    renderComp(makeEvent({ id: 42 }));
    await screen.findByRole("option", { name: "Facebook" });
    const [sourceSelect] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(sourceSelect, { target: { value: "Facebook" } });
    fireEvent.click(await screen.findByRole("button", { name: /save/i }));

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(3));
    expect(findCallWithQueryKey(invalidateSpy, getListAttributionEventsQueryKey())).toBeTruthy();
    expect(findCallWithQueryKey(invalidateSpy, getGetAttributionEventQueryKey(42))).toBeTruthy();
    expect(findCallWithQueryKey(invalidateSpy, ["attribution-event", 42])).toBeTruthy();
  });

  it("Bug #3: Funnel change defaults to 'Just this lead' and POSTs to /funnel-override", async () => {
    const { mock, calls } = makeFetchMock([
      { match: "/api/funnel-types", handler: () => ({ funnelTypes: [{ id: 7, name: "Lead Magnet" }, { id: 9, name: "Webinar" }] }) },
      { match: "/api/lead-source-aliases", handler: () => ({ aliases: [] }) },
      { match: "/funnel-override", method: "POST", handler: () => ({ lead: { id: 555 }, funnelOverriddenAt: new Date().toISOString() }) },
    ]);
    vi.stubGlobal("fetch", mock);

    renderComp(makeEvent({ id: 42 }), { id: 555, funnelOverriddenAt: null });
    await screen.findByRole("option", { name: "Webinar" });
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const funnelSelect = selects.find(s => Array.from(s.options).some(o => o.text === "Webinar")) as HTMLSelectElement;
    fireEvent.change(funnelSelect, { target: { value: "9" } });

    // Default scope = "Just this lead" — find Save button in lead scope panel.
    const saveBtn = await screen.findByTestId("button-save-funnel-lead");
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(calls.some(c => c.url.includes("/api/leads/555/funnel-override") && c.init?.method === "POST")).toBe(true);
    });
    // Tenant-wide alias endpoint must NOT have been touched.
    expect(calls.some(c => c.url.includes("/api/funnel-aliases?") && c.init?.method === "POST")).toBe(false);
  });

  it("Bug #3: switching to 'All leads' scope triggers Preview → Confirm flow that POSTs to /funnel-aliases", async () => {
    const { mock, calls } = makeFetchMock([
      { match: "/api/funnel-types", handler: () => ({ funnelTypes: [{ id: 7, name: "Lead Magnet" }, { id: 9, name: "Webinar" }] }) },
      { match: "/api/lead-source-aliases", method: "GET", handler: () => ({ aliases: [] }) },
      { match: "/api/funnel-aliases/preview", handler: () => ({ events: 12, leads: 47, canonicalName: "Webinar" }) },
      { match: "/api/funnel-aliases", method: "POST", handler: () => ({ updatedEventCount: 12, updatedLeadCount: 47 }) },
    ]);
    vi.stubGlobal("fetch", mock);

    renderComp(makeEvent({ id: 42 }), { id: 555, funnelOverriddenAt: null });
    await screen.findByRole("option", { name: "Webinar" });
    const funnelSelect = (screen.getAllByRole("combobox") as HTMLSelectElement[])
      .find(s => Array.from(s.options).some(o => o.text === "Webinar")) as HTMLSelectElement;
    fireEvent.change(funnelSelect, { target: { value: "9" } });

    fireEvent.click(await screen.findByTestId("button-funnel-scope-alias"));
    fireEvent.click(await screen.findByTestId("button-preview-funnel-alias"));

    // Preview message should appear with the counts the endpoint returned.
    const previewText = await screen.findByTestId("text-alias-preview");
    expect(previewText.textContent).toMatch(/47/);
    expect(previewText.textContent).toMatch(/12/);

    fireEvent.click(screen.getByTestId("button-confirm-alias-save"));
    await waitFor(() => {
      expect(calls.some(c => c.url.includes("/api/funnel-aliases?") && c.init?.method === "POST")).toBe(true);
    });
  });

  it("Bug #2: Funnel dropdown re-syncs after event.resolvedFunnel changes", async () => {
    const { mock } = makeFetchMock([
      { match: "/api/funnel-types", handler: () => ({ funnelTypes: [{ id: 7, name: "Lead Magnet" }, { id: 9, name: "Webinar" }] }) },
      { match: "/api/lead-source-aliases", handler: () => ({ aliases: [] }) },
    ]);
    vi.stubGlobal("fetch", mock);

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <InlineIdentityCorrection tenantId={1} event={makeEvent({ id: 42, resolvedFunnel: "Lead Magnet" })} matchedLead={null} />
      </QueryClientProvider>,
    );
    await screen.findByRole("option", { name: "Webinar" });
    const funnelSelect = screen.getByTestId("select-funnel-type") as HTMLSelectElement;
    await waitFor(() => expect(funnelSelect.value).toBe("7"));

    // Simulate refetch returning the new canonical funnel — the dropdown must follow.
    rerender(
      <QueryClientProvider client={queryClient}>
        <InlineIdentityCorrection tenantId={1} event={makeEvent({ id: 42, resolvedFunnel: "Webinar" })} matchedLead={null} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(funnelSelect.value).toBe("9"));
  });

  it("Bug #3: 'Manually set — undo' pill appears when matchedLead.funnelOverriddenAt is set and DELETEs on click", async () => {
    const { mock, calls } = makeFetchMock([
      { match: "/api/funnel-types", handler: () => ({ funnelTypes: [{ id: 7, name: "Lead Magnet" }] }) },
      { match: "/api/lead-source-aliases", handler: () => ({ aliases: [] }) },
      { match: "/funnel-override", method: "DELETE", handler: () => ({ lead: { id: 555 }, cleared: true }) },
    ]);
    vi.stubGlobal("fetch", mock);

    renderComp(makeEvent({ id: 42 }), { id: 555, funnelOverriddenAt: new Date("2026-05-20T10:00:00Z").toISOString() });
    const undoBtn = await screen.findByTestId("button-clear-funnel-override");
    fireEvent.click(undoBtn);
    await waitFor(() => {
      expect(calls.some(c => c.url.includes("/api/leads/555/funnel-override") && c.init?.method === "DELETE")).toBe(true);
    });
  });
});
