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

type FetchHandler = () => unknown;

function makeFetchMock(handlers: Array<{ match: string; handler: FetchHandler; ok?: boolean }>) {
  return vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    for (const { match, handler, ok = true } of handlers) {
      if (u.includes(match)) {
        const data = handler();
        return { ok, json: async () => data } as Response;
      }
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
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

describe("InlineIdentityCorrection — cache invalidation on Save", () => {
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

  function renderComp(event: AttributionEvent) {
    return render(
      <QueryClientProvider client={queryClient}>
        <InlineIdentityCorrection tenantId={1} event={event} />
      </QueryClientProvider>,
    );
  }

  it("invalidates events list, generated detail, and custom ['attribution-event', id] keys after a Source save", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock([
        {
          match: "/api/funnel-types",
          handler: () => ({
            funnelTypes: [
              { id: 7, name: "Lead Magnet" },
              { id: 9, name: "Webinar" },
            ],
          }),
        },
        {
          match: "/api/lead-source-aliases",
          handler: () => ({
            aliases: [{ canonicalName: "Google" }, { canonicalName: "Facebook" }],
          }),
        },
      ]),
    );

    const event = makeEvent({ id: 42 });
    renderComp(event);

    // Wait for the lead-source-aliases fetch to populate the dropdown.
    await screen.findByRole("option", { name: "Facebook" });

    const [sourceSelect] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(sourceSelect, { target: { value: "Facebook" } });

    const saveBtn = await screen.findByRole("button", { name: /save/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledTimes(3);
    });

    expect(
      findCallWithQueryKey(invalidateSpy, getListAttributionEventsQueryKey()),
      "events list query key was not invalidated after Source save",
    ).toBeTruthy();
    expect(
      findCallWithQueryKey(invalidateSpy, getGetAttributionEventQueryKey(42)),
      "generated event detail query key was not invalidated after Source save",
    ).toBeTruthy();
    expect(
      findCallWithQueryKey(invalidateSpy, ["attribution-event", 42]),
      "custom ['attribution-event', id] detail query key was not invalidated after Source save",
    ).toBeTruthy();
  });

  it("invalidates events list, generated detail, and custom ['attribution-event', id] keys after a Funnel save", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock([
        {
          match: "/api/funnel-types",
          handler: () => ({
            funnelTypes: [
              { id: 7, name: "Lead Magnet" },
              { id: 9, name: "Webinar" },
            ],
          }),
        },
        {
          match: "/api/lead-source-aliases",
          handler: () => ({ aliases: [{ canonicalName: "Google" }] }),
        },
      ]),
    );

    const event = makeEvent({ id: 42 });
    renderComp(event);

    // Wait for funnel-types to load (Webinar option appearing means funnelTypes is populated).
    await screen.findByRole("option", { name: "Webinar" });

    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const funnelSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.text === "Webinar"),
    ) as HTMLSelectElement;
    expect(funnelSelect).toBeDefined();

    // Switch funnel from "Lead Magnet" (id=7, current) to "Webinar" (id=9).
    fireEvent.change(funnelSelect, { target: { value: "9" } });

    const saveBtn = await screen.findByRole("button", { name: /save/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledTimes(3);
    });

    expect(
      findCallWithQueryKey(invalidateSpy, getListAttributionEventsQueryKey()),
      "events list query key was not invalidated after Funnel save",
    ).toBeTruthy();
    expect(
      findCallWithQueryKey(invalidateSpy, getGetAttributionEventQueryKey(42)),
      "generated event detail query key was not invalidated after Funnel save",
    ).toBeTruthy();
    expect(
      findCallWithQueryKey(invalidateSpy, ["attribution-event", 42]),
      "custom ['attribution-event', id] detail query key was not invalidated after Funnel save",
    ).toBeTruthy();
  });
});
