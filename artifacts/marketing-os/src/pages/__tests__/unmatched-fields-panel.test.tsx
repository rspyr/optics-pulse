import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  UNDO_CONFIRMATION_TIMEOUT_MS,
  UnmatchedFieldsPanel,
  type UnmatchedFieldsPanelEvent,
} from "../unmatched-fields-panel";

// Unified fetch mock that routes:
//   - GET /api/field-mapping-rules/suggestions  → tenant-wide learned suggestions
//   - GET /api/field-mapping-rules?...          → scoped preloaded rules
//   - POST/DELETE                               → per-test handler via `onOther`
function mockFetchAll(
  options: {
    suggestions?: Record<string, string>;
    rules?: Array<{ fieldName: string; mapsTo: string; id?: number }>;
    rulesGetResponse?: Partial<Response> & { json?: () => Promise<unknown> };
    onOther?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response;
  },
) {
  const suggestions = options.suggestions ?? {};
  const rules = options.rules ?? [];
  return vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method || "GET").toUpperCase();
    if (url.includes("/api/field-mapping-rules/suggestions")) {
      return { ok: true, status: 200, json: async () => ({ suggestions }) } as Response;
    }
    if (url.includes("/api/field-mapping-rules") && method === "GET") {
      if (options.rulesGetResponse) {
        return { ok: true, status: 200, json: async () => ({ rules }), ...options.rulesGetResponse } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ rules }) } as Response;
    }
    if (options.onOther) return options.onOther(input, init);
    return { ok: true, status: 200, json: async () => ({ rule: { id: 1 } }) } as Response;
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
    expect(screen.queryByText(/No matching click or lead found\./)).not.toBeInTheDocument();
  });

  it("uses singular 'field' when exactly one field is captured", () => {
    render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["only_one"] })} />);
    expect(screen.getByRole("button", { name: /Why unmatched\?/ })).toHaveTextContent("1 field captured");
  });

  it("expanding shows the reason banner", async () => {
    const user = userEvent.setup();
    mockFetchAll({});
    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    expect(screen.getByText("No matching click or lead found.")).toBeInTheDocument();
  });

  it("uses default reason text when unmatchedReason is missing", async () => {
    const user = userEvent.setup();
    mockFetchAll({});
    render(<UnmatchedFieldsPanel evt={makeEvent({ unmatchedReason: null })} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    expect(
      screen.getByText("Pulse could not link this fill to a known job, lead, or click."),
    ).toBeInTheDocument();
  });

  it("expanding reveals a 'Map to…' dropdown for each captured field", async () => {
    const user = userEvent.setup();
    mockFetchAll({});
    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    const select1 = await screen.findByRole("combobox", { name: "Map field_3 to" });
    const select2 = screen.getByRole("combobox", { name: "Map field_4 to" });
    expect(select1).toBeInTheDocument();
    expect(select2).toBeInTheDocument();

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

  it("does not issue any fetch when there are no captured field names", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchAll({});
    render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: [] })} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    // No rules to preload because the row list is empty — skip the GET entirely.
    // Note: the learned-suggestions fetch is also gated when there's nothing to suggest for.
    const ruleGets = fetchMock.mock.calls.filter(([u, init]) => {
      const url = typeof u === "string" ? u : (u as URL | Request).toString();
      const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
      return method === "GET" && url.includes("/api/field-mapping-rules") && !url.includes("/suggestions");
    });
    expect(ruleGets.length).toBe(0);
  });

  it("selecting a target POSTs to /api/field-mapping-rules with the correct body and shows success toast", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchAll({
      onOther: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ rule: { id: 1 } }),
      } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    const postCalls = await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([u, init]) => {
        const url = typeof u === "string" ? u : (u as URL | Request).toString();
        const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
        return method === "POST" && /\/api\/field-mapping-rules\?tenantId=/.test(url);
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
    expect(screen.getByRole("combobox", { name: "Map field_4 to" })).toBeInTheDocument();
  });

  it("HTTP 4xx shows error toast and does not mark the field as saved", async () => {
    const user = userEvent.setup();
    mockFetchAll({
      onOther: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "mapsTo must be one of: phone, email" }),
      } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledTimes(1);
    });
    expect(toastMock.error.mock.calls[0][0]).toBe("mapsTo must be one of: phone, email");
    expect(toastMock.success).not.toHaveBeenCalled();

    expect(screen.getByRole("combobox", { name: "Map field_3 to" })).toBeInTheDocument();
    expect(screen.queryByText(/mapped → phone/)).not.toBeInTheDocument();
  });

  it("uses fallback error message when 4xx body has no error field", async () => {
    const user = userEvent.setup();
    mockFetchAll({
      onOther: async () => ({
        ok: false,
        status: 403,
        json: async () => ({}),
      } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
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
    mockFetchAll({
      onOther: async () => {
        throw new Error("network down");
      },
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
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
    const fetchMock = mockFetchAll({});
    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches tenant suggestions on expand and pre-selects a learned target the static heuristic can't infer", async () => {
    const user = userEvent.setup();
    mockFetchAll({ suggestions: { field_3: "phone" } });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    const select = await screen.findByRole("combobox", { name: "Map field_3 to" });
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("phone");
    });
    expect(await screen.findByText("learned")).toBeInTheDocument();
  });

  it("falls back to the static heuristic when the tenant has no learned suggestion for the field", async () => {
    const user = userEvent.setup();
    mockFetchAll({ suggestions: {} });

    render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["phone_number"] })} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    const select = await screen.findByRole("combobox", { name: "Map phone_number to" });
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("phone");
    });
    expect(screen.getByText("suggested")).toBeInTheDocument();
  });

  it("after saving a mapping, a sibling panel for the same tenant pre-selects that field next time", async () => {
    const user = userEvent.setup();
    mockFetchAll({
      suggestions: {},
      onOther: async () => ({ ok: true, status: 200, json: async () => ({ rule: { id: 1 } }) } as Response),
    });

    const { unmount } = render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);
    unmount();

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
      if (url.includes("/api/field-mapping-rules") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ rules: [] }) } as Response;
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
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByText(/mapped → phone/)).toBeInTheDocument();

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
      if (url.includes("/api/field-mapping-rules") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ rules: [] }) } as Response;
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
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
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
      if (url.includes("/api/field-mapping-rules") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ rules: [] }) } as Response;
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

    const deleteCalls = fetchMock.mock.calls.filter(([u, init]) => {
      const url = typeof u === "string" ? u : (u as URL | Request).toString();
      return (init?.method || "").toUpperCase() === "DELETE" && /\/api\/field-mapping-rules\/100/.test(url);
    });
    expect(deleteCalls.length).toBe(1);
  });

  it("auto-cancels an armed undo confirmation after a short idle period", async () => {
    const user = userEvent.setup();
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (method === "POST") {
        return { ok: true, status: 200, json: async () => ({ rule: { id: 999 } }) } as Response;
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

    // Switch to fake timers AFTER the async setup is done — using fake timers
    // earlier would freeze the polling inside findBy*/waitFor.
    vi.useFakeTimers();
    try {
      // fireEvent is synchronous and avoids userEvent's internal delays
      // (which would otherwise hang under fake timers).
      fireEvent.click(undoBtn);
      // Armed.
      expect(undoBtn).toHaveTextContent(/Click again to confirm/);
      expect(screen.getByRole("button", { name: "Cancel undo for field_3" })).toBeInTheDocument();

      // Just shy of the timeout — still armed.
      act(() => {
        vi.advanceTimersByTime(UNDO_CONFIRMATION_TIMEOUT_MS - 1);
      });
      expect(undoBtn).toHaveTextContent(/Click again to confirm/);

      // Cross the timeout — confirmation auto-disarms back to idle.
      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(undoBtn).toHaveTextContent(/^Undo$/);
      expect(screen.queryByRole("button", { name: "Cancel undo for field_3" })).not.toBeInTheDocument();
      // Mapping is still saved — the auto-cancel does NOT delete anything.
      expect(screen.getByText(/mapped → phone/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fresh click within the idle window resets the auto-cancel timer", async () => {
    const user = userEvent.setup();
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (method === "POST") {
        return { ok: true, status: 200, json: async () => ({ rule: { id: 888 } }) } as Response;
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

    vi.useFakeTimers();
    try {
      fireEvent.click(undoBtn);
      expect(undoBtn).toHaveTextContent(/Click again to confirm/);

      // Operator cancels well before the timeout, then re-arms — the auto-
      // cancel should restart from the second arming, not fire from the first.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel undo for field_3" }));
      expect(undoBtn).toHaveTextContent(/^Undo$/);

      fireEvent.click(undoBtn);
      expect(undoBtn).toHaveTextContent(/Click again to confirm/);

      // Advance only past where the FIRST arming would have expired — the new
      // arming should still be hot.
      act(() => {
        vi.advanceTimersByTime(UNDO_CONFIRMATION_TIMEOUT_MS - 500);
      });
      expect(undoBtn).toHaveTextContent(/Click again to confirm/);

      // Now cross the timeout for the second arming.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(undoBtn).toHaveTextContent(/^Undo$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapsing the 'Why unmatched?' panel disarms any pending undo confirmations inside it", async () => {
    const user = userEvent.setup();
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (method === "POST") {
        return { ok: true, status: 200, json: async () => ({ rule: { id: 444 } }) } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    render(<UnmatchedFieldsPanel evt={makeEvent() } />);
    const toggle = screen.getByRole("button", { name: /Why unmatched\?/ });
    await user.click(toggle);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);

    // Arm the undo confirmation.
    const undoBtn = await screen.findByRole("button", { name: "Undo mapping for field_3" });
    await user.click(undoBtn);
    expect(undoBtn).toHaveTextContent(/Click again to confirm/);
    expect(screen.getByRole("button", { name: "Cancel undo for field_3" })).toBeInTheDocument();

    // Collapse the panel — the saved row unmounts, dropping its armed state.
    await user.click(toggle);
    expect(screen.queryByRole("button", { name: "Undo mapping for field_3" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel undo for field_3" })).not.toBeInTheDocument();

    // Re-expand — the row comes back in its idle state, NOT still armed.
    await user.click(toggle);
    const undoBtnAgain = await screen.findByRole("button", { name: "Undo mapping for field_3" });
    expect(undoBtnAgain).toHaveTextContent(/^Undo$/);
    expect(screen.queryByRole("button", { name: "Cancel undo for field_3" })).not.toBeInTheDocument();
    // Mapping is still saved — collapse/expand does not delete anything.
    expect(screen.getByText(/mapped → phone/)).toBeInTheDocument();
  });

  it("silently tolerates a failing tenant-suggestions fetch (still falls back to the static heuristic)", async () => {
    const user = userEvent.setup();
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        throw new Error("network down");
      }
      if (url.includes("/api/field-mapping-rules") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ rules: [] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["phone_number"] })} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    const select = await screen.findByRole("combobox", { name: "Map phone_number to" });
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("phone");
    });
    expect(screen.queryByText("learned")).not.toBeInTheDocument();
    expect(screen.getByText("suggested")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------
  // Preload-existing-rules behavior (Task #264).
  // ---------------------------------------------------------------

  it("preloads existing field-mapping rules on expand and shows 'already mapped → X' for each", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchAll({
      rules: [
        { fieldName: "field_3", mapsTo: "phone", id: 11 },
        { fieldName: "field_4", mapsTo: "email", id: 12 },
      ],
    });

    render(<UnmatchedFieldsPanel evt={makeEvent() /* fieldNames: field_3, field_4 */} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    // Find the scoped GET (the rules preload, not the suggestions GET).
    const getRulesCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, init]) => {
        const url = typeof u === "string" ? u : (u as URL | Request).toString();
        const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
        return method === "GET"
          && url.includes("/api/field-mapping-rules")
          && !url.includes("/suggestions")
          && url.includes("pageUrlPattern=");
      });
      expect(call).toBeDefined();
      return call!;
    });
    const getUrl = getRulesCall[0] as string;
    expect(getUrl).toMatch(/tenantId=42/);
    expect(getUrl).toMatch(/pageUrlPattern=%2Fcontact/);
    expect(getUrl).toMatch(/formIdentifier=contact-form-1/);

    expect(await screen.findByText(/already mapped → phone/)).toBeInTheDocument();
    expect(screen.getByText(/already mapped → email/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Map field_3 to" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Map field_4 to" })).not.toBeInTheDocument();
  });

  it("preloads only the matching subset and leaves un-mapped fields editable", async () => {
    const user = userEvent.setup();
    mockFetchAll({
      rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }],
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    expect(await screen.findByText(/already mapped → phone/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Map field_4 to" })).toBeInTheDocument();
  });

  it("ignores rules that do not match any captured field name in this event", async () => {
    const user = userEvent.setup();
    mockFetchAll({
      rules: [{ fieldName: "field_99", mapsTo: "phone", id: 99 }],
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    expect(await screen.findByRole("combobox", { name: "Map field_3 to" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Map field_4 to" })).toBeInTheDocument();
    expect(screen.queryByText(/already mapped → phone/)).not.toBeInTheDocument();
  });

  it("does not refetch rules on subsequent collapse + re-expand", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchAll({
      rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }],
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    const toggle = screen.getByRole("button", { name: /Why unmatched\?/ });

    const ruleGetsSoFar = () => fetchMock.mock.calls.filter(([u, init]) => {
      const url = typeof u === "string" ? u : (u as URL | Request).toString();
      const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
      return method === "GET" && url.includes("/api/field-mapping-rules") && !url.includes("/suggestions");
    }).length;

    await user.click(toggle);
    await waitFor(() => {
      expect(ruleGetsSoFar()).toBe(1);
    });

    await user.click(toggle);
    expect(ruleGetsSoFar()).toBe(1);

    await user.click(toggle);
    expect(ruleGetsSoFar()).toBe(1);
  });

  it("treats a forbidden rules-fetch (HTTP 403) as 'no rules' without breaking the panel", async () => {
    const user = userEvent.setup();
    mockFetchAll({
      rules: [],
      rulesGetResponse: { ok: false, status: 403, json: async () => ({ error: "forbidden" }) },
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    expect(await screen.findByRole("combobox", { name: "Map field_3 to" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Map field_4 to" })).toBeInTheDocument();
    expect(screen.queryByText(/already mapped/)).not.toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("treats a network error during rules-fetch as 'no rules' without breaking the panel", async () => {
    const user = userEvent.setup();
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (url.includes("/api/field-mapping-rules") && method === "GET") {
        throw new Error("network down");
      }
      return { ok: true, status: 200, json: async () => ({ rule: { id: 1 } }) } as Response;
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    expect(await screen.findByRole("combobox", { name: "Map field_3 to" })).toBeInTheDocument();
    expect(screen.queryByText(/already mapped/)).not.toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("clicking 'Change' on an already-mapped field opens the dropdown preselected to the current target, and re-saving updates the badge", async () => {
    const user = userEvent.setup();
    mockFetchAll({
      rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }],
      onOther: async () => ({ ok: true, status: 200, json: async () => ({ rule: { id: 11 } }) } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    expect(await screen.findByText(/already mapped → phone/)).toBeInTheDocument();
    const changeButton = screen.getByRole("button", { name: /Change mapping for field_3/ });
    await user.click(changeButton);

    const select = await screen.findByRole("combobox", { name: "Map field_3 to" });
    expect((select as HTMLSelectElement).value).toBe("phone");
    // Save button is hidden because the selection equals the current saved value (no change).
    expect(screen.queryByRole("button", { name: /^Save$/ })).not.toBeInTheDocument();

    await user.selectOptions(select, "email");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    // Re-saving an already-preloaded field keeps the "already mapped" semantics (just with the new target).
    expect(await screen.findByText(/already mapped → email/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Map field_3 to" })).not.toBeInTheDocument();
    expect(toastMock.success.mock.calls.at(-1)?.[0]).toMatch(/Mapped "field_3" → email/);
  });

  it("'Cancel' on a re-mapping in progress reverts to the 'already mapped' badge", async () => {
    const user = userEvent.setup();
    mockFetchAll({
      rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }],
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    expect(await screen.findByText(/already mapped → phone/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Change mapping for field_3/ }));
    expect(await screen.findByRole("combobox", { name: "Map field_3 to" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));

    expect(await screen.findByText(/already mapped → phone/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Map field_3 to" })).not.toBeInTheDocument();
  });
});
