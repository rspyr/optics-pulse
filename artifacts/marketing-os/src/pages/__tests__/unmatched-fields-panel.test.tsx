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

  it("saved row exposes an Undo button and DELETEs the rule by id (after confirmation), returning the row to editable state", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (method === "POST" && /\/api\/field-mapping-rules\?tenantId=/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ rule: { id: 777 } }) } as Response;
      }
      if (method === "DELETE" && /\/api\/field-mapping-rules\/777/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ success: true }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByText(/mapped → phone/)).toBeInTheDocument();

    // Undo button is present on the saved row.
    const undoBtn = await screen.findByRole("button", { name: "Undo mapping for field_3" });
    expect(undoBtn).toBeInTheDocument();

    // First click arms the confirmation but DOES NOT issue a DELETE.
    await user.click(undoBtn);
    expect(undoBtn).toHaveTextContent(/Click again to confirm/);
    expect(
      fetchMock.mock.calls.filter(([u, init]) => {
        const url = typeof u === "string" ? u : (u as URL | Request).toString();
        return (init?.method || "").toUpperCase() === "DELETE" && url.includes("/api/field-mapping-rules/777");
      }).length,
    ).toBe(0);

    // Second click on the same Undo button confirms and triggers the DELETE.
    await user.click(undoBtn);

    // A DELETE for rule id 777 was issued, with tenantId in the query string.
    await waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.filter(([u, init]) => {
        const url = typeof u === "string" ? u : (u as URL | Request).toString();
        return (init?.method || "").toUpperCase() === "DELETE" && url.includes("/api/field-mapping-rules/777");
      });
      expect(deleteCalls.length).toBe(1);
      const [calledUrl, calledInit] = deleteCalls[0];
      expect(calledUrl).toMatch(/\/api\/field-mapping-rules\/777\?tenantId=42$/);
      expect(calledInit?.credentials).toBe("include");
    });

    // Row reverts to the editable Map-to state and the saved indicator is gone.
    await waitFor(() => {
      expect(screen.queryByText(/mapped → phone/)).not.toBeInTheDocument();
    });
    expect(screen.getByRole("combobox", { name: "Map field_3 to" })).toBeInTheDocument();
    expect(toastMock.success).toHaveBeenLastCalledWith(expect.stringMatching(/Removed mapping for "field_3"/));
  });

  it("a single click on Undo only arms an inline confirmation — no DELETE is issued", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (method === "POST") {
        return { ok: true, status: 200, json: async () => ({ rule: { id: 555 } }) } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);

    const undoBtn = await screen.findByRole("button", { name: "Undo mapping for field_3" });
    expect(undoBtn).toHaveTextContent(/^Undo$/);

    await user.click(undoBtn);

    // Visible label flips to the confirmation prompt.
    expect(undoBtn).toHaveTextContent(/Click again to confirm/);
    // A Cancel button now sits beside it.
    expect(screen.getByRole("button", { name: "Cancel undo for field_3" })).toBeInTheDocument();
    // Mapping indicator is still visible — nothing was deleted.
    expect(screen.getByText(/mapped → phone/)).toBeInTheDocument();
    // No DELETE was sent.
    const deleteCalls = fetchMock.mock.calls.filter(([, init]) => (init?.method || "").toUpperCase() === "DELETE");
    expect(deleteCalls.length).toBe(0);
    // No success/error toast for removal yet.
    expect(toastMock.success).not.toHaveBeenCalledWith(expect.stringMatching(/Removed mapping/));
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("Cancel disarms the confirmation and returns the Undo button to its idle label", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (method === "POST") {
        return { ok: true, status: 200, json: async () => ({ rule: { id: 321 } }) } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);

    const undoBtn = await screen.findByRole("button", { name: "Undo mapping for field_3" });
    await user.click(undoBtn);
    const cancelBtn = await screen.findByRole("button", { name: "Cancel undo for field_3" });

    await user.click(cancelBtn);

    // Cancel goes away.
    expect(screen.queryByRole("button", { name: "Cancel undo for field_3" })).not.toBeInTheDocument();
    // Undo button is back to its idle label.
    expect(undoBtn).toHaveTextContent(/^Undo$/);
    // Mapping is still saved.
    expect(screen.getByText(/mapped → phone/)).toBeInTheDocument();
    // Still no DELETE.
    const deleteCalls = fetchMock.mock.calls.filter(([, init]) => (init?.method || "").toUpperCase() === "DELETE");
    expect(deleteCalls.length).toBe(0);
  });

  it("each saved row tracks its own confirmation independently — confirming one does not arm or affect another", async () => {
    const user = userEvent.setup();
    let nextRuleId = 200;
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: { field_3: "phone", field_4: "email" } }) } as Response;
      }
      if (method === "POST") {
        return { ok: true, status: 200, json: async () => ({ rule: { id: nextRuleId++ } }) } as Response;
      }
      if (method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({ success: true }) } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    await waitFor(() => {
      const sel3 = screen.getByRole("combobox", { name: "Map field_3 to" }) as HTMLSelectElement;
      const sel4 = screen.getByRole("combobox", { name: "Map field_4 to" }) as HTMLSelectElement;
      expect(sel3.value).toBe("phone");
      expect(sel4.value).toBe("email");
    });
    await user.click(screen.getByRole("button", { name: /Save all suggested/ }));

    await waitFor(() => {
      expect(screen.getByText(/mapped → phone/)).toBeInTheDocument();
      expect(screen.getByText(/mapped → email/)).toBeInTheDocument();
    });

    const undo3 = screen.getByRole("button", { name: "Undo mapping for field_3" });
    const undo4 = screen.getByRole("button", { name: "Undo mapping for field_4" });

    // Arm field_3 only.
    await user.click(undo3);
    expect(undo3).toHaveTextContent(/Click again to confirm/);
    // field_4's Undo button is unaffected.
    expect(undo4).toHaveTextContent(/^Undo$/);
    expect(screen.queryByRole("button", { name: "Cancel undo for field_4" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel undo for field_3" })).toBeInTheDocument();

    // Clicking field_4's Undo arms only field_4 — it does NOT confirm field_3.
    await user.click(undo4);
    const deleteCallsAfter = fetchMock.mock.calls.filter(([, init]) => (init?.method || "").toUpperCase() === "DELETE");
    expect(deleteCallsAfter.length).toBe(0);
    expect(undo4).toHaveTextContent(/Click again to confirm/);
    expect(screen.getByRole("button", { name: "Cancel undo for field_4" })).toBeInTheDocument();
    // field_3 is still armed (not yet confirmed).
    expect(undo3).toHaveTextContent(/Click again to confirm/);
    // Both mappings are still present.
    expect(screen.getByText(/mapped → phone/)).toBeInTheDocument();
    expect(screen.getByText(/mapped → email/)).toBeInTheDocument();
  });

  it("undo failure (HTTP 4xx) shows error toast and keeps the row in saved state", async () => {
    const user = userEvent.setup();
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (method === "POST") {
        return { ok: true, status: 200, json: async () => ({ rule: { id: 12 } }) } as Response;
      }
      if (method === "DELETE") {
        return { ok: false, status: 404, json: async () => ({ error: "Rule not found" }) } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);

    // Two clicks: arm + confirm.
    const undoBtn = screen.getByRole("button", { name: "Undo mapping for field_3" });
    await user.click(undoBtn);
    await user.click(undoBtn);

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Rule not found");
    });
    // Row stays in saved state because the delete failed.
    expect(screen.getByText(/mapped → phone/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Map field_3 to" })).not.toBeInTheDocument();
  });

  it("works for rows saved via 'Save all suggested': each saved row exposes its own Undo", async () => {
    const user = userEvent.setup();
    let nextRuleId = 100;
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: { field_3: "phone", field_4: "email" } }) } as Response;
      }
      if (method === "POST") {
        return { ok: true, status: 200, json: async () => ({ rule: { id: nextRuleId++ } }) } as Response;
      }
      if (method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({ success: true }) } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    // Wait for both fields to be pre-selected from learned suggestions, then bulk-save.
    await waitFor(() => {
      const sel3 = screen.getByRole("combobox", { name: "Map field_3 to" }) as HTMLSelectElement;
      const sel4 = screen.getByRole("combobox", { name: "Map field_4 to" }) as HTMLSelectElement;
      expect(sel3.value).toBe("phone");
      expect(sel4.value).toBe("email");
    });
    await user.click(screen.getByRole("button", { name: /Save all suggested/ }));

    // Both rows are now saved.
    await waitFor(() => {
      expect(screen.getByText(/mapped → phone/)).toBeInTheDocument();
      expect(screen.getByText(/mapped → email/)).toBeInTheDocument();
    });

    // Each saved row exposes its own Undo button.
    const undo3 = screen.getByRole("button", { name: "Undo mapping for field_3" });
    const undo4 = screen.getByRole("button", { name: "Undo mapping for field_4" });
    expect(undo3).toBeInTheDocument();
    expect(undo4).toBeInTheDocument();

    // Undo just field_3 — field_4 stays saved. (Two clicks: arm + confirm.)
    await user.click(undo3);
    await user.click(undo3);
    await waitFor(() => {
      expect(screen.queryByText(/mapped → phone/)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/mapped → email/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Map field_3 to" })).toBeInTheDocument();

    // The DELETE was sent for the rule id assigned to field_3 (the first POST: 100).
    const deleteCalls = fetchMock.mock.calls.filter(([u, init]) => {
      const url = typeof u === "string" ? u : (u as URL | Request).toString();
      return (init?.method || "").toUpperCase() === "DELETE" && /\/api\/field-mapping-rules\/100/.test(url);
    });
    expect(deleteCalls.length).toBe(1);
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
