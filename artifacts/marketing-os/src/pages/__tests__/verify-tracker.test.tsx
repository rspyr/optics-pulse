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
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
});
