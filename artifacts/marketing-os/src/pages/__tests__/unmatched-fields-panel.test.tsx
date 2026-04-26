import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { toastMock } = vi.hoisted(() => ({
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: toastMock,
}));

import {
  __resetLearnedSuggestionsCacheForTests,
  deriveMappingScope,
  UnmatchedFieldsPanel,
  type UnmatchedFieldsPanelEvent,
} from "../unmatched-fields-panel";

// Helper to install a fetch mock that routes the per-tenant learned-suggestions
// GET to a specific payload (default: empty), and forwards everything else to
// the per-test mock provided by the caller.
function mockFetchWithSuggestions(
  options: {
    suggestions?: Record<string, string>;
    onOther: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response;
  },
) {
  const suggestions = options.suggestions ?? {};
  return vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/field-mapping-rules/suggestions")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ suggestions }),
      } as Response;
    }
    return options.onOther(input, init);
  });
}

function makeEvent(overrides: Partial<UnmatchedFieldsPanelEvent> = {}): UnmatchedFieldsPanelEvent {
  return {
    tenantId: 42,
    pageUrl: "https://example.com/contact",
    formId: "contact-form-1",
    formName: "Contact",
    fieldNames: ["field_3", "field_4"],
    unmatchedReason: "No matching click or lead found.",
    ...overrides,
  };
}

describe("deriveMappingScope", () => {
  it("extracts pathname from a real https URL", () => {
    const scope = deriveMappingScope({
      pageUrl: "https://example.com/contact?utm_source=g",
      formId: "form-1",
      formName: null,
    });
    expect(scope.pageUrlPattern).toBe("/contact");
  });

  it("extracts pathname from a real http URL", () => {
    const scope = deriveMappingScope({
      pageUrl: "http://example.com/landing/offer",
      formId: "form-1",
      formName: null,
    });
    expect(scope.pageUrlPattern).toBe("/landing/offer");
  });

  it("falls back to '*' when pageUrl is an invalid URL string", () => {
    const scope = deriveMappingScope({
      pageUrl: "not a url",
      formId: "form-1",
      formName: null,
    });
    expect(scope.pageUrlPattern).toBe("*");
  });

  it("falls back to '*' when pageUrl is empty", () => {
    const scope = deriveMappingScope({
      pageUrl: "",
      formId: "form-1",
      formName: null,
    });
    expect(scope.pageUrlPattern).toBe("*");
  });

  it("falls back to '*' when pageUrl is null", () => {
    const scope = deriveMappingScope({
      pageUrl: null,
      formId: "form-1",
      formName: null,
    });
    expect(scope.pageUrlPattern).toBe("*");
  });

  it("prefers formId over formName", () => {
    const scope = deriveMappingScope({
      pageUrl: "https://example.com/",
      formId: "id-from-id",
      formName: "name-from-name",
    });
    expect(scope.formIdentifier).toBe("id-from-id");
  });

  it("uses formName when formId is empty/whitespace", () => {
    const scope = deriveMappingScope({
      pageUrl: "https://example.com/",
      formId: "   ",
      formName: "name-from-name",
    });
    expect(scope.formIdentifier).toBe("name-from-name");
  });

  it("uses formName when formId is null", () => {
    const scope = deriveMappingScope({
      pageUrl: "https://example.com/",
      formId: null,
      formName: "name-from-name",
    });
    expect(scope.formIdentifier).toBe("name-from-name");
  });

  it("falls back to '*' when both formId and formName are null", () => {
    const scope = deriveMappingScope({
      pageUrl: "https://example.com/",
      formId: null,
      formName: null,
    });
    expect(scope.formIdentifier).toBe("*");
  });

  it("falls back to '*' when both formId and formName are whitespace/empty", () => {
    const scope = deriveMappingScope({
      pageUrl: "https://example.com/",
      formId: "  ",
      formName: "",
    });
    expect(scope.formIdentifier).toBe("*");
  });
});

describe("UnmatchedFieldsPanel", () => {
  beforeEach(() => {
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    vi.spyOn(global, "fetch").mockReset();
    __resetLearnedSuggestionsCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetLearnedSuggestionsCacheForTests();
  });

  it("renders the 'Why unmatched?' toggle with field count, collapsed by default", () => {
    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    const toggle = screen.getByRole("button", { name: /Why unmatched\?/ });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveTextContent("2 fields captured");
    // Reason banner only appears once expanded.
    expect(screen.queryByText(/No matching click or lead found\./)).not.toBeInTheDocument();
  });

  it("uses singular 'field' when exactly one field is captured", () => {
    render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["only_one"] })} />);
    expect(screen.getByRole("button", { name: /Why unmatched\?/ })).toHaveTextContent("1 field captured");
  });

  it("expanding shows the reason banner", async () => {
    const user = userEvent.setup();
    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    expect(screen.getByText("No matching click or lead found.")).toBeInTheDocument();
  });

  it("uses default reason text when unmatchedReason is missing", async () => {
    const user = userEvent.setup();
    render(<UnmatchedFieldsPanel evt={makeEvent({ unmatchedReason: null })} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    expect(
      screen.getByText("Pulse could not link this fill to a known job, lead, or click."),
    ).toBeInTheDocument();
  });

  it("expanding reveals a 'Map to…' dropdown for each captured field", async () => {
    const user = userEvent.setup();
    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    const select1 = screen.getByRole("combobox", { name: "Map field_3 to" });
    const select2 = screen.getByRole("combobox", { name: "Map field_4 to" });
    expect(select1).toBeInTheDocument();
    expect(select2).toBeInTheDocument();

    // Verify options include core targets.
    const optionLabels = Array.from(select1.querySelectorAll("option")).map((o) => o.textContent);
    expect(optionLabels).toContain("phone");
    expect(optionLabels).toContain("email");
    expect(optionLabels).toContain("appointmentTime");
  });

  it("shows the empty-state message when no field names were captured", async () => {
    const user = userEvent.setup();
    render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: [] })} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    expect(
      screen.getByText(/No field names were captured for this submit/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("selecting a target POSTs to /api/field-mapping-rules with the correct body and shows success toast", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchWithSuggestions({
      onOther: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ rule: { id: 1 } }),
      } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    // The new UX requires an explicit Save click after selecting a target,
    // so the operator can confirm the (possibly heuristic-suggested) value.
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    const postCalls = await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([u]) => {
        const url = typeof u === "string" ? u : (u as URL | Request).toString();
        return /\/api\/field-mapping-rules\?tenantId=/.test(url);
      });
      expect(calls.length).toBe(1);
      return calls;
    });

    const [calledUrl, calledInit] = postCalls[0];
    expect(calledUrl).toMatch(/\/api\/field-mapping-rules\?tenantId=42$/);
    expect(calledInit?.method).toBe("POST");
    expect(calledInit?.credentials).toBe("include");
    expect(JSON.parse(calledInit?.body as string)).toEqual({
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      fieldName: "field_3",
      mapsTo: "phone",
    });

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledTimes(1);
    });
    expect(toastMock.success.mock.calls[0][0]).toMatch(/Mapped "field_3" → phone/);

    // Field is now marked as saved — dropdown is replaced by the "mapped → phone" indicator.
    expect(await screen.findByText(/mapped → phone/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Map field_3 to" })).not.toBeInTheDocument();
    // The other field is unaffected.
    expect(screen.getByRole("combobox", { name: "Map field_4 to" })).toBeInTheDocument();
  });

  it("HTTP 4xx shows error toast and does not mark the field as saved", async () => {
    const user = userEvent.setup();
    mockFetchWithSuggestions({
      onOther: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "mapsTo must be one of: phone, email" }),
      } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledTimes(1);
    });
    expect(toastMock.error.mock.calls[0][0]).toBe("mapsTo must be one of: phone, email");
    expect(toastMock.success).not.toHaveBeenCalled();

    // Dropdown is still present — the field was NOT marked as saved.
    expect(screen.getByRole("combobox", { name: "Map field_3 to" })).toBeInTheDocument();
    expect(screen.queryByText(/mapped → phone/)).not.toBeInTheDocument();
  });

  it("uses fallback error message when 4xx body has no error field", async () => {
    const user = userEvent.setup();
    mockFetchWithSuggestions({
      onOther: async () => ({
        ok: false,
        status: 403,
        json: async () => ({}),
      } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledTimes(1);
    });
    expect(toastMock.error.mock.calls[0][0]).toBe("Failed to save mapping (HTTP 403)");
  });

  it("network error shows error toast and does not mark the field as saved", async () => {
    const user = userEvent.setup();
    mockFetchWithSuggestions({
      onOther: async () => {
        throw new Error("network down");
      },
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledTimes(1);
    });
    expect(toastMock.error.mock.calls[0][0]).toBe("Network error saving mapping rule.");
    expect(screen.getByRole("combobox", { name: "Map field_3 to" })).toBeInTheDocument();
  });

  it("does NOT fetch tenant suggestions while the panel is collapsed", async () => {
    const fetchMock = mockFetchWithSuggestions({
      onOther: async () => ({ ok: true, status: 200, json: async () => ({}) } as Response),
    });
    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    // No expand → no fetch at all (suggestions endpoint should be untouched).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches tenant suggestions on expand and pre-selects a learned target the static heuristic can't infer", async () => {
    const user = userEvent.setup();
    mockFetchWithSuggestions({
      suggestions: { field_3: "phone" },
      onOther: async () => ({ ok: true, status: 200, json: async () => ({}) } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    const select = await screen.findByRole("combobox", { name: "Map field_3 to" });
    // Wait for the async fetch + state update to settle.
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("phone");
    });
    // The hint label should say "learned" for a tenant-history-driven pre-selection.
    expect(await screen.findByText("learned")).toBeInTheDocument();
  });

  it("falls back to the static heuristic when the tenant has no learned suggestion for the field", async () => {
    const user = userEvent.setup();
    mockFetchWithSuggestions({
      suggestions: {},
      onOther: async () => ({ ok: true, status: 200, json: async () => ({}) } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["phone_number"] })} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    const select = await screen.findByRole("combobox", { name: "Map phone_number to" });
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("phone");
    });
    // For a heuristic-driven (not learned) pre-selection, the hint says "suggested".
    expect(screen.getByText("suggested")).toBeInTheDocument();
  });

  it("after saving a mapping, a sibling panel for the same tenant pre-selects that field next time", async () => {
    const user = userEvent.setup();
    mockFetchWithSuggestions({
      suggestions: {},
      onOther: async () => ({ ok: true, status: 200, json: async () => ({ rule: { id: 1 } }) } as Response),
    });

    // First panel: operator confirms field_3 → phone.
    const { unmount } = render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);
    unmount();

    // Second panel for a DIFFERENT form on the same tenant: field_3 should now
    // pre-select phone from the in-memory learned cache, even though the
    // tenant suggestions endpoint still returns nothing.
    render(<UnmatchedFieldsPanel evt={makeEvent({ formId: "different-form", fieldNames: ["field_3"] })} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    const select = await screen.findByRole("combobox", { name: "Map field_3 to" });
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("phone");
    });
    expect(await screen.findByText("learned")).toBeInTheDocument();
  });

  it("silently tolerates a failing tenant-suggestions fetch (still falls back to the static heuristic)", async () => {
    const user = userEvent.setup();
    // Fail the suggestions endpoint AND any other call.
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        throw new Error("network down");
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["phone_number"] })} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    // Static heuristic still pre-selects phone.
    const select = await screen.findByRole("combobox", { name: "Map phone_number to" });
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("phone");
    });
    // Hint should NOT be "learned" — heuristic only.
    expect(screen.queryByText("learned")).not.toBeInTheDocument();
    expect(screen.getByText("suggested")).toBeInTheDocument();
  });
});
