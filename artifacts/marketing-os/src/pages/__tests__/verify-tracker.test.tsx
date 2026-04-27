import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { socketState, socketFactory, toastMock } = vi.hoisted(() => {
  const state: {
    handlers: Map<string, (...args: unknown[]) => void>;
    emitted: Array<{ event: string; args: unknown[] }>;
    disconnected: boolean;
  } = {
    handlers: new Map(),
    emitted: [],
    disconnected: false,
  };
  const factory = () => ({
    on(event: string, handler: (...args: unknown[]) => void) {
      state.handlers.set(event, handler);
    },
    emit(event: string, ...args: unknown[]) {
      state.emitted.push({ event, args });
    },
    disconnect() {
      state.disconnected = true;
    },
  });
  return {
    socketState: state,
    socketFactory: factory,
    toastMock: { success: vi.fn(), error: vi.fn() },
  };
});

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => socketFactory()),
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

import VerifyTracker from "../verify-tracker";
import { __resetLearnedSuggestionsCacheForTests } from "../unmatched-fields-panel";

function makeVerifyResult(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/contact",
    host: "example.com",
    overall: "green" as const,
    findings: [],
    scripts: [],
    pageScriptKind: "pulse-current",
    installVerdict: "pulse-ok",
    formInventory: [],
    statusBreakdown: {
      last24h: { total: 0, submitOk: 0, submitClientError: 0, submitRateLimited: 0, submitServerError: 0 },
      last7d: { total: 0, submitOk: 0, submitClientError: 0, submitRateLimited: 0, submitServerError: 0 },
    },
    heartbeats: [
      { tenantId: 42, tenantName: "Acme HVAC", lastSeenAt: "2026-04-26T00:00:00.000Z", firstPageUrl: null },
    ],
    recentEventCount24h: 0,
    recentAttempts: [],
    debugUrl: "https://example.com/contact?_pulse_debug=1",
    captureUrl: "https://example.com/contact?_pulse_capture=1",
    ...overrides,
  };
}

describe("VerifyTracker integration — unmatched panel renders on new-attribution-event", () => {
  beforeEach(() => {
    socketState.handlers.clear();
    socketState.emitted.length = 0;
    socketState.disconnected = false;
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    // The page persists captured events to localStorage by host —
    // clear so events don't leak between tests.
    window.localStorage.clear();
    // Prefetch and panel hydration share a module-level cache; reset it so
    // prior tests don't make the prefetch a no-op cache hit.
    __resetLearnedSuggestionsCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetLearnedSuggestionsCacheForTests();
  });

  it("renders UnmatchedFieldsPanel inside the matching LiveEventCard when an unmatched event arrives over the socket", async () => {
    const user = userEvent.setup();

    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/verify-tracker")) {
        return {
          ok: true,
          status: 200,
          json: async () => makeVerifyResult(),
        } as Response;
      }
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<VerifyTracker />);

    // Trigger the verify flow which establishes the socket and starts listening.
    await user.type(screen.getByPlaceholderText(/your-landing-page/i), "https://example.com/contact");
    await user.click(screen.getByRole("button", { name: /^Verify$/ }));

    // Wait for the live feed card (only renders after VerifyResult is set).
    await screen.findByText(/Live attribution feed/i);

    // Socket should have been wired up.
    const newEventHandler = socketState.handlers.get("new-attribution-event");
    expect(newEventHandler).toBeDefined();
    const connectHandler = socketState.handlers.get("connect");
    expect(connectHandler).toBeDefined();

    // Simulate the socket connecting — this triggers the join-tenant emit.
    connectHandler!();
    expect(socketState.emitted).toEqual([{ event: "join-tenant", args: [42] }]);

    // Now simulate an inbound new-attribution-event with matchLevel=unmatched
    // and a pageUrl matching the verified host.
    newEventHandler!({
      id: 9001,
      tenantId: 42,
      matchLevel: "unmatched",
      matchConfidence: 0,
      resolvedLeadSource: null,
      resolvedFunnel: null,
      formType: "native",
      formId: "ac-breakdown-prevention",
      formName: "AC Breakdown",
      pageUrl: "https://example.com/contact",
      landingPage: "https://example.com/contact",
      hasPhone: true,
      hasEmail: false,
      gclid: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      submittedAt: "2026-04-26T01:00:00.000Z",
      receivedAt: "2026-04-26T01:00:01.000Z",
      fieldNames: ["field_3", "field_7"],
      unmatchedReason: "No matching click or lead found in the last 30 days.",
    });

    // The event card should appear, including the unmatched panel toggle with the field count.
    await waitFor(() => {
      expect(screen.getByText(/Event #9001/)).toBeInTheDocument();
    });
    const toggle = screen.getByRole("button", { name: /Why unmatched\?/ });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveTextContent("2 fields captured");

    // Expanding shows the reason banner, confirming the unmatchedReason was wired through.
    await user.click(toggle);
    expect(
      screen.getByText("No matching click or lead found in the last 30 days."),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Map field_3 to" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Map field_7 to" })).toBeInTheDocument();
  });

  it("does NOT render UnmatchedFieldsPanel for matched (non-unmatched) events", async () => {
    const user = userEvent.setup();

    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/verify-tracker")) {
        return {
          ok: true,
          status: 200,
          json: async () => makeVerifyResult(),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<VerifyTracker />);
    await user.type(screen.getByPlaceholderText(/your-landing-page/i), "https://example.com/contact");
    await user.click(screen.getByRole("button", { name: /^Verify$/ }));
    await screen.findByText(/Live attribution feed/i);

    socketState.handlers.get("connect")!();
    socketState.handlers.get("new-attribution-event")!({
      id: 9002,
      tenantId: 42,
      matchLevel: "diamond",
      matchConfidence: 1,
      resolvedLeadSource: "google",
      resolvedFunnel: "ac-breakdown",
      formType: "native",
      formId: "ac-breakdown-prevention",
      formName: "AC Breakdown",
      pageUrl: "https://example.com/contact",
      landingPage: "https://example.com/contact",
      hasPhone: true,
      hasEmail: true,
      gclid: "abc",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "ac-breakdown",
      submittedAt: "2026-04-26T01:00:00.000Z",
      receivedAt: "2026-04-26T01:00:01.000Z",
      fieldNames: ["phone", "email"],
      unmatchedReason: null,
    });

    await waitFor(() => {
      expect(screen.getByText(/Event #9002/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Why unmatched\?/ })).not.toBeInTheDocument();
  });

  // Task #282: prefetch field-mapping rules for visible unmatched events so
  // the first time the operator clicks "Why unmatched?" the panel hydrates
  // from the shared cache instead of paying the round-trip.
  it("prefetches field-mapping rules when an unmatched event arrives, so expanding the panel issues no extra GET", async () => {
    const user = userEvent.setup();

    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/verify-tracker")) {
        return { ok: true, status: 200, json: async () => makeVerifyResult() } as Response;
      }
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (url.includes("/api/field-mapping-rules") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ rules: [{ id: 77, fieldName: "field_3", mapsTo: "phone" }] }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    render(<VerifyTracker />);
    await user.type(screen.getByPlaceholderText(/your-landing-page/i), "https://example.com/contact");
    await user.click(screen.getByRole("button", { name: /^Verify$/ }));
    await screen.findByText(/Live attribution feed/i);

    socketState.handlers.get("connect")!();
    socketState.handlers.get("new-attribution-event")!({
      id: 9101,
      tenantId: 42,
      matchLevel: "unmatched",
      matchConfidence: 0,
      resolvedLeadSource: null,
      resolvedFunnel: null,
      formType: "native",
      formId: "ac-breakdown-prevention",
      formName: "AC Breakdown",
      pageUrl: "https://example.com/contact",
      landingPage: "https://example.com/contact",
      hasPhone: true,
      hasEmail: false,
      gclid: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      submittedAt: "2026-04-26T01:00:00.000Z",
      receivedAt: "2026-04-26T01:00:01.000Z",
      fieldNames: ["field_3", "field_4"],
      unmatchedReason: "No matching click or lead found.",
    });

    const ruleGetsFor = () =>
      fetchMock.mock.calls.filter(([u, init]) => {
        const url = typeof u === "string" ? u : (u as URL | Request).toString();
        const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
        return method === "GET"
          && url.includes("/api/field-mapping-rules")
          && !url.includes("/suggestions")
          && url.includes("pageUrlPattern=");
      });

    // Prefetch should fire as soon as the unmatched event renders.
    await waitFor(() => {
      expect(ruleGetsFor().length).toBe(1);
    });
    const prefetchCount = ruleGetsFor().length;

    // Now the operator opens the panel. The shared cache should already have
    // the rule, so expanding must NOT issue an additional rules-fetch.
    const toggle = await screen.findByRole("button", { name: /Why unmatched\?/ });
    await user.click(toggle);

    // The preloaded rule from the prefetch should appear instantly.
    await waitFor(() => {
      expect(screen.getByText(/already mapped → phone/)).toBeInTheDocument();
    });

    // Still exactly the prefetched count — no extra GET on expand.
    expect(ruleGetsFor().length).toBe(prefetchCount);
  });

  // Task #294 — surface non-`native` capture paths as a chip on each row of
  // the live attribution feed so operators can tell at a glance when
  // pulse.js had to fall back to a builder-specific or wide-scan path.
  it("renders a CapturePathBadge with tooltip for honeypot-rescue events and skips it for native events", async () => {
    const user = userEvent.setup();

    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/verify-tracker")) {
        return { ok: true, status: 200, json: async () => makeVerifyResult() } as Response;
      }
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<VerifyTracker />);
    await user.type(screen.getByPlaceholderText(/your-landing-page/i), "https://example.com/contact");
    await user.click(screen.getByRole("button", { name: /^Verify$/ }));
    await screen.findByText(/Live attribution feed/i);

    const handler = socketState.handlers.get("new-attribution-event")!;
    socketState.handlers.get("connect")!();

    // First, a native-path event — should NOT get a capture-path badge.
    handler({
      id: 9201,
      tenantId: 42,
      matchLevel: "diamond",
      matchConfidence: 1,
      resolvedLeadSource: "google",
      resolvedFunnel: "ac",
      formType: "native",
      formId: "ac-form",
      formName: "AC",
      pageUrl: "https://example.com/contact",
      landingPage: "https://example.com/contact",
      hasPhone: true, hasEmail: true,
      gclid: null, utmSource: null, utmMedium: null, utmCampaign: null,
      submittedAt: "2026-04-26T01:00:00.000Z",
      receivedAt: "2026-04-26T01:00:01.000Z",
      fieldNames: ["phone", "email"],
      unmatchedReason: null,
    });
    await waitFor(() => expect(screen.getByText(/Event #9201/)).toBeInTheDocument());
    expect(screen.queryByTestId(/^capture-path-badge-/)).not.toBeInTheDocument();

    // Now a honeypot-rescue event — should render the amber badge with tooltip.
    handler({
      id: 9202,
      tenantId: 42,
      matchLevel: "golden",
      matchConfidence: 0.8,
      resolvedLeadSource: "google",
      resolvedFunnel: "ac",
      formType: "honeypot-rescue",
      formId: "rescue-form",
      formName: "Rescue",
      pageUrl: "https://example.com/contact",
      landingPage: "https://example.com/contact",
      hasPhone: true, hasEmail: true,
      gclid: null, utmSource: null, utmMedium: null, utmCampaign: null,
      submittedAt: "2026-04-26T01:00:02.000Z",
      receivedAt: "2026-04-26T01:00:03.000Z",
      fieldNames: ["phone", "email"],
      unmatchedReason: null,
    });
    const badge = await screen.findByTestId("capture-path-badge-honeypot-rescue");
    expect(badge).toHaveTextContent(/honeypot-rescue/);
    expect(badge.getAttribute("title") ?? "").toMatch(/wide-scan|honeypot/i);

    // And a leadconnector event — distinct purple badge with its own tooltip.
    handler({
      id: 9203,
      tenantId: 42,
      matchLevel: "diamond",
      matchConfidence: 1,
      resolvedLeadSource: "google",
      resolvedFunnel: "ac",
      formType: "leadconnector",
      formId: "ghl-form",
      formName: "GHL",
      pageUrl: "https://example.com/contact",
      landingPage: "https://example.com/contact",
      hasPhone: true, hasEmail: true,
      gclid: null, utmSource: null, utmMedium: null, utmCampaign: null,
      submittedAt: "2026-04-26T01:00:04.000Z",
      receivedAt: "2026-04-26T01:00:05.000Z",
      fieldNames: ["phone", "email"],
      unmatchedReason: null,
    });
    const ghlBadge = await screen.findByTestId("capture-path-badge-leadconnector");
    expect(ghlBadge).toHaveTextContent(/leadconnector/);
    expect(ghlBadge.getAttribute("title") ?? "").toMatch(/GoHighLevel|LeadConnector/i);

    // gravity and wpcf7 are also non-`native` capture paths — they should
    // each get their own badge so operators can spot the WordPress builders.
    handler({
      id: 9204,
      tenantId: 42,
      matchLevel: "diamond",
      matchConfidence: 1,
      resolvedLeadSource: "google",
      resolvedFunnel: "ac",
      formType: "gravity",
      formId: "gf-1",
      formName: "GF",
      pageUrl: "https://example.com/contact",
      landingPage: "https://example.com/contact",
      hasPhone: true, hasEmail: true,
      gclid: null, utmSource: null, utmMedium: null, utmCampaign: null,
      submittedAt: "2026-04-26T01:00:06.000Z",
      receivedAt: "2026-04-26T01:00:07.000Z",
      fieldNames: ["phone", "email"],
      unmatchedReason: null,
    });
    const gfBadge = await screen.findByTestId("capture-path-badge-gravity");
    expect(gfBadge).toHaveTextContent(/gravity/);
    expect(gfBadge.getAttribute("title") ?? "").toMatch(/Gravity Forms/i);

    handler({
      id: 9205,
      tenantId: 42,
      matchLevel: "diamond",
      matchConfidence: 1,
      resolvedLeadSource: "google",
      resolvedFunnel: "ac",
      formType: "wpcf7",
      formId: "cf7-1",
      formName: "CF7",
      pageUrl: "https://example.com/contact",
      landingPage: "https://example.com/contact",
      hasPhone: true, hasEmail: true,
      gclid: null, utmSource: null, utmMedium: null, utmCampaign: null,
      submittedAt: "2026-04-26T01:00:08.000Z",
      receivedAt: "2026-04-26T01:00:09.000Z",
      fieldNames: ["phone", "email"],
      unmatchedReason: null,
    });
    const cf7Badge = await screen.findByTestId("capture-path-badge-wpcf7");
    expect(cf7Badge).toHaveTextContent(/wpcf7/);
    expect(cf7Badge.getAttribute("title") ?? "").toMatch(/Contact Form 7/i);
  });

  // Task #294 (review) — the warning-link detector should fire on the
  // canonical "Honeypot-only form detected" header (case-insensitive) too,
  // not only when the literal token "honeypot-rescue" appears in the
  // message. This guards against future copy tweaks on the API side.
  it("renders the jump-to-feed link when the warning uses 'Honeypot-only form detected' header instead of the literal 'honeypot-rescue' token", async () => {
    const user = userEvent.setup();

    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/verify-tracker")) {
        return {
          ok: true,
          status: 200,
          json: async () => makeVerifyResult({
            findings: [
              { level: "warning", message: "HONEYPOT-ONLY FORM DETECTED — investigate the customer's HTML." },
            ],
          }),
        } as Response;
      }
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<VerifyTracker />);
    await user.type(screen.getByPlaceholderText(/your-landing-page/i), "https://example.com/contact");
    await user.click(screen.getByRole("button", { name: /^Verify$/ }));
    await screen.findByText(/Live attribution feed/i);

    // The jump-to-feed link must still render even though the message
    // doesn't contain the lowercase "honeypot-rescue" token.
    expect(
      screen.getByRole("button", { name: /Jump to honeypot-rescue rows in feed/i }),
    ).toBeInTheDocument();
  });

  // Task #294 — the "Honeypot-only form detected" warning should expose a
  // jump-to-feed control that scrolls the live feed into view AND highlights
  // any honeypot-rescue rows so operators can match the warning to captures.
  it("renders a 'Jump to honeypot-rescue rows' link on the honeypot warning that highlights matching feed rows", async () => {
    const user = userEvent.setup();

    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/verify-tracker")) {
        return {
          ok: true,
          status: 200,
          json: async () => makeVerifyResult({
            findings: [
              {
                level: "warning",
                message: "Honeypot-only form detected — Pulse.js falls back to a wider scan and labels these submissions as honeypot-rescue.",
              },
            ],
          }),
        } as Response;
      }
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // Stub scrollIntoView (jsdom doesn't implement it).
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy as unknown as Element["scrollIntoView"];

    render(<VerifyTracker />);
    await user.type(screen.getByPlaceholderText(/your-landing-page/i), "https://example.com/contact");
    await user.click(screen.getByRole("button", { name: /^Verify$/ }));
    await screen.findByText(/Live attribution feed/i);

    // Push a honeypot-rescue event so there's something to highlight.
    socketState.handlers.get("connect")!();
    socketState.handlers.get("new-attribution-event")!({
      id: 9301,
      tenantId: 42,
      matchLevel: "golden",
      matchConfidence: 0.8,
      resolvedLeadSource: "google",
      resolvedFunnel: "ac",
      formType: "honeypot-rescue",
      formId: "rescue-form",
      formName: "Rescue",
      pageUrl: "https://example.com/contact",
      landingPage: "https://example.com/contact",
      hasPhone: true, hasEmail: true,
      gclid: null, utmSource: null, utmMedium: null, utmCampaign: null,
      submittedAt: "2026-04-26T01:00:00.000Z",
      receivedAt: "2026-04-26T01:00:01.000Z",
      fieldNames: ["phone", "email"],
      unmatchedReason: null,
    });
    await waitFor(() => expect(screen.getByText(/Event #9301/)).toBeInTheDocument());

    // The row starts un-highlighted.
    const row = screen.getByText(/Event #9301/).closest("[data-form-type]") as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.className).not.toMatch(/ring-amber-400/);

    // Click the "Jump to" link in the warning.
    const jumpBtn = screen.getByRole("button", { name: /Jump to honeypot-rescue rows in feed/i });
    await user.click(jumpBtn);

    // It scrolls the live feed anchor into view…
    expect(scrollSpy).toHaveBeenCalled();
    // …and the honeypot-rescue row picks up the amber highlight ring.
    await waitFor(() => {
      const updated = screen.getByText(/Event #9301/).closest("[data-form-type]") as HTMLElement;
      expect(updated.className).toMatch(/ring-amber-400/);
    });
  });
});
