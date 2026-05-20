import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const { useOptionalLeadNotificationMock, useLeadNotificationMock } = vi.hoisted(() => ({
  useOptionalLeadNotificationMock: vi.fn(),
  useLeadNotificationMock: vi.fn(),
}));
vi.mock("@/contexts/lead-notification-context", async () => {
  const { mockLeadNotificationModule } = await import("@/test-utils/lead-notification-mocks");
  return mockLeadNotificationModule({
    useOptionalLeadNotification: useOptionalLeadNotificationMock,
    useLeadNotification: useLeadNotificationMock,
  });
});

import { makeLeadNotificationStub } from "@/test-utils/lead-notification-mocks";
useOptionalLeadNotificationMock.mockReturnValue(null);
useLeadNotificationMock.mockReturnValue(makeLeadNotificationStub());

import {
  __resetLearnedSuggestionsCacheForTests,
  deriveMappingScope,
  LEARNED_SUGGESTIONS_FRESHNESS_WINDOW_MS,
  RULES_UPDATED_HINT_DURATION_MS,
  SCOPED_RULES_FRESHNESS_WINDOW_MS,
  UNDO_CONFIRMATION_TIMEOUT_MS,
  UnmatchedFieldsPanel,
  usePrefetchScopedRules,
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

describe("UnmatchedFieldsPanel — captured field values", () => {
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

  it("renders the captured value next to each field name when fieldValues is provided", async () => {
    const user = userEvent.setup();
    mockFetchAll({});
    render(
      <UnmatchedFieldsPanel
        evt={makeEvent({
          fieldNames: ["company_url", "phone"],
          fieldValues: { company_url: "https://acme.com", phone: "555-1234" },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    expect(screen.getByTestId("captured-value-company_url")).toHaveTextContent("https://acme.com");
    expect(screen.getByTestId("captured-value-phone")).toHaveTextContent("555-1234");
  });

  it("renders the (empty) placeholder for an empty-string captured value (the screenshot bug)", async () => {
    const user = userEvent.setup();
    mockFetchAll({});
    render(
      <UnmatchedFieldsPanel
        evt={makeEvent({
          fieldNames: ["company_url"],
          fieldValues: { company_url: "" },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    expect(screen.getByTestId("captured-value-company_url")).toHaveTextContent("(empty)");
  });

  it("renders (no value) placeholders for null/undefined and compact JSON for objects/arrays", async () => {
    const user = userEvent.setup();
    mockFetchAll({});
    render(
      <UnmatchedFieldsPanel
        evt={makeEvent({
          fieldNames: ["a", "b", "c", "d"],
          fieldValues: { a: null, b: undefined, c: { nested: true }, d: ["x", "y"] },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    expect(screen.getByTestId("captured-value-a")).toHaveTextContent("(no value)");
    expect(screen.getByTestId("captured-value-b")).toHaveTextContent("(no value)");
    expect(screen.getByTestId("captured-value-c")).toHaveTextContent('{"nested":true}');
    expect(screen.getByTestId("captured-value-d")).toHaveTextContent('["x","y"]');
  });

  it("omits the value row entirely when fieldValues is not provided (live SSE feed parity)", async () => {
    const user = userEvent.setup();
    mockFetchAll({});
    render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["field_3"] })} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    expect(screen.queryByTestId("captured-value-field_3")).not.toBeInTheDocument();
  });

  it("omits the value row for fields whose name is not present in fieldValues (partial map)", async () => {
    const user = userEvent.setup();
    mockFetchAll({});
    render(
      <UnmatchedFieldsPanel
        evt={makeEvent({
          fieldNames: ["field_3", "field_4"],
          fieldValues: { field_3: "captured" },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    expect(screen.getByTestId("captured-value-field_3")).toHaveTextContent("captured");
    expect(screen.queryByTestId("captured-value-field_4")).not.toBeInTheDocument();
  });

  it("preserves the captured value display after the field is mapped (saved row)", async () => {
    const user = userEvent.setup();
    mockFetchAll({
      onOther: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ rule: { id: 1 } }),
      } as Response),
    });

    render(
      <UnmatchedFieldsPanel
        evt={makeEvent({
          fieldNames: ["field_3"],
          fieldValues: { field_3: "555-1234" },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    expect(screen.getByTestId("captured-value-field_3")).toHaveTextContent("555-1234");

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByText(/mapped → phone/)).toBeInTheDocument();

    // The submitted value still renders next to the field name on the saved row.
    expect(screen.getByTestId("captured-value-field_3")).toHaveTextContent("555-1234");
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

    // Clicking field_4's Undo arms only field_4 — it does NOT confirm field_3
    // (and the outside-click disarm logic disarms field_3, since clicking
    // field_4 is "outside" field_3's row — a stray confirm of field_3 must
    // not be triggered by interacting with another row).
    await user.click(undo4);
    const deleteCallsAfter = fetchMock.mock.calls.filter(([, init]) => (init?.method || "").toUpperCase() === "DELETE");
    expect(deleteCallsAfter.length).toBe(0);
    expect(undo4).toHaveTextContent(/Click again to confirm/);
    expect(screen.getByRole("button", { name: "Cancel undo for field_4" })).toBeInTheDocument();
    // field_3 is now disarmed (the click on field_4 was outside field_3's row).
    expect(undo3).toHaveTextContent(/^Undo$/);
    expect(screen.queryByRole("button", { name: "Cancel undo for field_3" })).not.toBeInTheDocument();
    // Both mappings are still present — no DELETE was fired for either.
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

  it("clicking outside the row disarms the pending Undo confirmation", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (method === "POST") {
        return { ok: true, status: 200, json: async () => ({ rule: { id: 654 } }) } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    // Render an unrelated element OUTSIDE the panel so we can simulate a
    // click somewhere else on the page (e.g. global header, another tab).
    render(
      <div>
        <button type="button">outside-target</button>
        <UnmatchedFieldsPanel evt={makeEvent()} />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);

    const undoBtn = await screen.findByRole("button", { name: "Undo mapping for field_3" });
    await user.click(undoBtn);
    expect(undoBtn).toHaveTextContent(/Click again to confirm/);
    expect(screen.getByRole("button", { name: "Cancel undo for field_3" })).toBeInTheDocument();

    // Click on something outside the row — confirmation should disarm.
    await user.click(screen.getByRole("button", { name: "outside-target" }));

    expect(undoBtn).toHaveTextContent(/^Undo$/);
    expect(screen.queryByRole("button", { name: "Cancel undo for field_3" })).not.toBeInTheDocument();
    // Mapping is still saved, no DELETE was issued.
    expect(screen.getByText(/mapped → phone/)).toBeInTheDocument();
    const deleteCalls = fetchMock.mock.calls.filter(([, init]) => (init?.method || "").toUpperCase() === "DELETE");
    expect(deleteCalls.length).toBe(0);
  });

  it("clicking inside the same row (Cancel button) still disarms via its own handler, not outside-click", async () => {
    const user = userEvent.setup();
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (method === "POST") {
        return { ok: true, status: 200, json: async () => ({ rule: { id: 655 } }) } as Response;
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
    // Clicking the in-row Cancel button must not be misinterpreted as an
    // outside click — Cancel still works as before.
    await user.click(screen.getByRole("button", { name: "Cancel undo for field_3" }));
    expect(undoBtn).toHaveTextContent(/^Undo$/);
    expect(screen.getByText(/mapped → phone/)).toBeInTheDocument();
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

  // ---------------------------------------------------------------
  // Collapsed-summary 'already mapped' count (Task #270).
  // ---------------------------------------------------------------

  it("does not show an 'already mapped' count in the toggle before the panel has ever been expanded", () => {
    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    const toggle = screen.getByRole("button", { name: /Why unmatched\?/ });
    expect(toggle).toHaveTextContent("2 fields captured");
    expect(toggle).not.toHaveTextContent(/already mapped/);
  });

  it("shows 'X of N already mapped' in the toggle once preload has completed (partial mapping)", async () => {
    const user = userEvent.setup();
    mockFetchAll({
      rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }],
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    const toggle = screen.getByRole("button", { name: /Why unmatched\?/ });
    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveTextContent("1 of 2 already mapped");
    });
    // Original "(N fields captured)" hint stays.
    expect(toggle).toHaveTextContent("2 fields captured");
  });

  it("shows 'all N already mapped' when every captured field has a preloaded rule", async () => {
    const user = userEvent.setup();
    mockFetchAll({
      rules: [
        { fieldName: "field_3", mapsTo: "phone", id: 11 },
        { fieldName: "field_4", mapsTo: "email", id: 12 },
      ],
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    const toggle = screen.getByRole("button", { name: /Why unmatched\?/ });
    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveTextContent("all 2 already mapped");
    });
    expect(toggle).not.toHaveTextContent(/2 of 2/);
  });

  it("does not add a count when preload returns no matching rules", async () => {
    const user = userEvent.setup();
    mockFetchAll({ rules: [] });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    const toggle = screen.getByRole("button", { name: /Why unmatched\?/ });
    await user.click(toggle);

    // Wait for the preload GET to settle and the editable rows to render.
    await screen.findByRole("combobox", { name: "Map field_3 to" });
    expect(toggle).toHaveTextContent("2 fields captured");
    expect(toggle).not.toHaveTextContent(/already mapped/);
  });

  it("count persists across collapse + re-expand without a refetch", async () => {
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
      expect(toggle).toHaveTextContent("1 of 2 already mapped");
    });
    expect(ruleGetsSoFar()).toBe(1);

    // Collapse — the count should still be visible in the toggle row.
    await user.click(toggle);
    expect(toggle).toHaveTextContent("1 of 2 already mapped");
    expect(ruleGetsSoFar()).toBe(1);

    // Re-expand — still cached, no extra request.
    await user.click(toggle);
    expect(toggle).toHaveTextContent("1 of 2 already mapped");
    expect(ruleGetsSoFar()).toBe(1);
  });

  it("count updates after the operator saves a new mapping in-session", async () => {
    const user = userEvent.setup();
    mockFetchAll({
      rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }],
      onOther: async () => ({ ok: true, status: 200, json: async () => ({ rule: { id: 22 } }) } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    const toggle = screen.getByRole("button", { name: /Why unmatched\?/ });
    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveTextContent("1 of 2 already mapped");
    });

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_4 to" }),
      "email",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(toggle).toHaveTextContent("all 2 already mapped");
    });
  });

  it("count drops back after an undo of a preloaded mapping", async () => {
    const user = userEvent.setup();
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (url.includes("/api/field-mapping-rules") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ rules: [{ fieldName: "field_3", mapsTo: "phone", id: 99 }] }),
        } as Response;
      }
      if (method === "DELETE" && /\/api\/field-mapping-rules\/99/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ success: true }) } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    const toggle = screen.getByRole("button", { name: /Why unmatched\?/ });
    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveTextContent("1 of 2 already mapped");
    });

    const undoBtn = await screen.findByRole("button", { name: "Undo mapping for field_3" });
    await user.click(undoBtn);
    await user.click(undoBtn);

    await waitFor(() => {
      expect(toggle).not.toHaveTextContent(/already mapped/);
    });
    expect(toggle).toHaveTextContent("2 fields captured");
  });

  // ---------------------------------------------------------------
  // Shared scope-rules cache (Task #271): many panels for the same
  // (tenantId, pageUrlPattern, formIdentifier) scope share one fetch
  // and reflect each other's saves without an extra network call.
  // ---------------------------------------------------------------

  it("two panels with the same scope share a single rules-fetch on expand", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchAll({
      rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }],
    });

    const evt = makeEvent({ fieldNames: ["field_3", "field_4"] });
    render(
      <>
        <UnmatchedFieldsPanel evt={evt} />
        <UnmatchedFieldsPanel evt={evt} />
      </>,
    );

    const toggles = screen.getAllByRole("button", { name: /Why unmatched\?/ });
    expect(toggles).toHaveLength(2);
    await user.click(toggles[0]);
    await user.click(toggles[1]);

    // Both panels should preload the same rule from the shared cache.
    await waitFor(() => {
      expect(screen.getAllByText(/already mapped → phone/)).toHaveLength(2);
    });

    // Exactly ONE rules GET should have been issued for the shared scope —
    // the second panel must hit the cache instead of refetching.
    const ruleGets = fetchMock.mock.calls.filter(([u, init]) => {
      const url = typeof u === "string" ? u : (u as URL | Request).toString();
      const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
      return method === "GET"
        && url.includes("/api/field-mapping-rules")
        && !url.includes("/suggestions")
        && url.includes("pageUrlPattern=");
    });
    expect(ruleGets.length).toBe(1);
  });

  it("a save in one panel updates the shared cache; the sibling panel reflects the new rule without an extra fetch", async () => {
    const user = userEvent.setup();
    let nextRuleId = 800;
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (url.includes("/api/field-mapping-rules") && method === "GET") {
        // Both panels share this scope — there should only ever be one such GET.
        return { ok: true, status: 200, json: async () => ({ rules: [] }) } as Response;
      }
      if (method === "POST" && /\/api\/field-mapping-rules\?tenantId=/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ rule: { id: nextRuleId++ } }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });

    const evt = makeEvent({ fieldNames: ["field_3"] });
    render(
      <>
        <UnmatchedFieldsPanel evt={evt} />
        <UnmatchedFieldsPanel evt={evt} />
      </>,
    );

    const toggles = screen.getAllByRole("button", { name: /Why unmatched\?/ });
    await user.click(toggles[0]);
    await user.click(toggles[1]);

    // Both panels start out with editable Map-to dropdowns (no preloaded rules).
    await waitFor(() => {
      expect(screen.getAllByRole("combobox", { name: "Map field_3 to" })).toHaveLength(2);
    });

    // Panel A saves field_3 → phone.
    const selects = screen.getAllByRole("combobox", { name: "Map field_3 to" });
    await user.selectOptions(selects[0], "phone");
    await user.click(screen.getAllByRole("button", { name: /^Save$/ })[0]);

    // After the save, the cache update notifies the sibling panel:
    // - Panel A (the saver) shows "mapped → phone" (in-session).
    // - Panel B (the sibling) shows "already mapped → phone" (preloaded from cache).
    await waitFor(() => {
      expect(screen.getByText(/already mapped → phone/)).toBeInTheDocument();
    });
    // Distinguish "mapped → phone" (panel A) from "already mapped → phone" (panel B):
    // both badges should be present, exactly one each.
    const allMappedBadges = screen.getAllByText(/mapped → phone/);
    expect(allMappedBadges).toHaveLength(2);
    const newlyMapped = allMappedBadges.filter((el) => !/already mapped/.test(el.textContent || ""));
    expect(newlyMapped).toHaveLength(1);

    // No additional rules-fetch was issued — the sibling reflected the update via the cache subscriber.
    const ruleGets = fetchMock.mock.calls.filter(([u, init]) => {
      const url = typeof u === "string" ? u : (u as URL | Request).toString();
      const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
      return method === "GET"
        && url.includes("/api/field-mapping-rules")
        && !url.includes("/suggestions")
        && url.includes("pageUrlPattern=");
    });
    expect(ruleGets.length).toBe(1);
  });

  it("a save that happens while a same-scope rules-fetch is still in flight survives the fetch's completion", async () => {
    const user = userEvent.setup();
    let releaseRulesGet: (() => void) | null = null;
    let nextRuleId = 900;
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/field-mapping-rules/suggestions")) {
        return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
      }
      if (url.includes("/api/field-mapping-rules") && method === "GET") {
        // Hold the rules-fetch open until the test releases it. This lets us
        // sandwich a successful POST between fetch start and fetch resolve.
        await new Promise<void>((resolve) => { releaseRulesGet = resolve; });
        return { ok: true, status: 200, json: async () => ({ rules: [] }) } as Response;
      }
      if (method === "POST" && /\/api\/field-mapping-rules\?tenantId=/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ rule: { id: nextRuleId++ } }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });

    const evt = makeEvent({ fieldNames: ["field_3"] });
    render(
      <>
        <UnmatchedFieldsPanel evt={evt} />
        <UnmatchedFieldsPanel evt={evt} />
      </>,
    );

    const toggles = screen.getAllByRole("button", { name: /Why unmatched\?/ });
    // Panel A starts the rules fetch (which blocks until releaseRulesGet runs).
    await user.click(toggles[0]);
    // Panel B joins the inflight fetch — does not issue its own.
    await user.click(toggles[1]);

    // Both panels render their editable rows even while rules are loading.
    await waitFor(() => {
      expect(screen.getAllByRole("combobox", { name: "Map field_3 to" })).toHaveLength(2);
    });

    // While the GET is still pending, save in Panel A.
    const selects = screen.getAllByRole("combobox", { name: "Map field_3 to" });
    await user.selectOptions(selects[0], "phone");
    await user.click(screen.getAllByRole("button", { name: /^Save$/ })[0]);

    // Panel A should already show "mapped → phone" before the GET resolves.
    await waitFor(() => {
      expect(screen.getByText(/^mapped → phone$/)).toBeInTheDocument();
    });

    // Now release the GET — it returns an empty rules list. The fetch
    // completion must NOT clobber Panel A's freshly saved mapping; instead
    // it should merge the local write into the result, so:
    // - Panel A keeps "mapped → phone".
    // - Panel B picks up the new rule as "already mapped → phone".
    expect(releaseRulesGet).not.toBeNull();
    releaseRulesGet?.();

    await waitFor(() => {
      expect(screen.getByText(/already mapped → phone/)).toBeInTheDocument();
    });
    expect(screen.getByText(/^mapped → phone$/)).toBeInTheDocument();

    // Still only one rules GET — sibling panel B never fetched on its own.
    const ruleGets = fetchMock.mock.calls.filter(([u, init]) => {
      const url = typeof u === "string" ? u : (u as URL | Request).toString();
      const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
      return method === "GET"
        && url.includes("/api/field-mapping-rules")
        && !url.includes("/suggestions")
        && url.includes("pageUrlPattern=");
    });
    expect(ruleGets.length).toBe(1);
  });

  // ---------------------------------------------------------------
  // Prefetch (Task #282): visible unmatched events warm the shared
  // scoped-rules cache so the FIRST expand for any given panel hits
  // the cache instead of paying a round-trip.
  // ---------------------------------------------------------------

  it("usePrefetchScopedRules issues exactly one rules-fetch per unique scope and dedupes shared scopes", async () => {
    const fetchMock = mockFetchAll({});

    function Harness({
      events,
    }: {
      events: Array<Pick<UnmatchedFieldsPanelEvent, "tenantId" | "pageUrl" | "formId" | "formName">>;
    }) {
      usePrefetchScopedRules(events);
      return null;
    }

    // Three events: two share a scope (same pageUrl + formId), one is distinct.
    const sharedA = { tenantId: 42, pageUrl: "https://example.com/contact", formId: "form-A", formName: null };
    const sharedB = { tenantId: 42, pageUrl: "https://example.com/contact", formId: "form-A", formName: null };
    const distinct = { tenantId: 42, pageUrl: "https://example.com/quote", formId: "form-B", formName: null };

    render(<Harness events={[sharedA, sharedB, distinct]} />);

    await waitFor(() => {
      const ruleGets = fetchMock.mock.calls.filter(([u, init]) => {
        const url = typeof u === "string" ? u : (u as URL | Request).toString();
        const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
        return method === "GET"
          && url.includes("/api/field-mapping-rules")
          && !url.includes("/suggestions")
          && url.includes("pageUrlPattern=");
      });
      // Two unique scopes → exactly two GETs (sharedA and sharedB collapse).
      expect(ruleGets.length).toBe(2);
    });
  });

  it("expanding a panel whose scope was prefetched issues no additional GET", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchAll({
      rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }],
    });

    const evt = makeEvent({ fieldNames: ["field_3", "field_4"] });

    function Harness({ enablePanel }: { enablePanel: boolean }) {
      // Prefetch warms the shared cache for the event's scope.
      usePrefetchScopedRules([{
        tenantId: evt.tenantId,
        pageUrl: evt.pageUrl,
        formId: evt.formId,
        formName: evt.formName,
      }]);
      return enablePanel ? <UnmatchedFieldsPanel evt={evt} /> : null;
    }

    // First mount: prefetch only — wait for it to land in the cache.
    const { rerender } = render(<Harness enablePanel={false} />);

    await waitFor(() => {
      const ruleGets = fetchMock.mock.calls.filter(([u, init]) => {
        const url = typeof u === "string" ? u : (u as URL | Request).toString();
        const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
        return method === "GET"
          && url.includes("/api/field-mapping-rules")
          && !url.includes("/suggestions")
          && url.includes("pageUrlPattern=");
      });
      expect(ruleGets.length).toBe(1);
    });

    // Now mount the panel and expand it. Because the scope was prefetched,
    // the panel should hydrate from the shared cache and issue NO additional
    // GET against /api/field-mapping-rules.
    rerender(<Harness enablePanel={true} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

    // The preloaded rule should be visible without any extra fetch.
    await waitFor(() => {
      expect(screen.getByText(/already mapped → phone/)).toBeInTheDocument();
    });

    const ruleGetsAfter = fetchMock.mock.calls.filter(([u, init]) => {
      const url = typeof u === "string" ? u : (u as URL | Request).toString();
      const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
      return method === "GET"
        && url.includes("/api/field-mapping-rules")
        && !url.includes("/suggestions")
        && url.includes("pageUrlPattern=");
    });
    // Still exactly one rules-fetch — the prefetch one. The expand was free.
    expect(ruleGetsAfter.length).toBe(1);
  });

  it("usePrefetchScopedRules swallows fetch errors silently (no toast)", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });

    function Harness() {
      usePrefetchScopedRules([{
        tenantId: 99,
        pageUrl: "https://example.com/contact",
        formId: "form-X",
        formName: null,
      }]);
      return null;
    }

    render(<Harness />);

    // Give the prefetch microtask a chance to run.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("panels with different scopes do NOT share the cache — each issues its own rules-fetch", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchAll({
      rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }],
    });

    render(
      <>
        <UnmatchedFieldsPanel evt={makeEvent({ formId: "form-A", fieldNames: ["field_3"] })} />
        <UnmatchedFieldsPanel evt={makeEvent({ formId: "form-B", fieldNames: ["field_3"] })} />
      </>,
    );

    const toggles = screen.getAllByRole("button", { name: /Why unmatched\?/ });
    await user.click(toggles[0]);
    await user.click(toggles[1]);

    await waitFor(() => {
      const ruleGets = fetchMock.mock.calls.filter(([u, init]) => {
        const url = typeof u === "string" ? u : (u as URL | Request).toString();
        const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
        return method === "GET"
          && url.includes("/api/field-mapping-rules")
          && !url.includes("/suggestions")
          && url.includes("pageUrlPattern=");
      });
      // Two scopes → two fetches.
      expect(ruleGets.length).toBe(2);
    });
  });

  // ---------------------------------------------------------------
  // Scope-rules cache refresh on visibility change (Task #281).
  //
  // The shared scope-rules cache lives forever otherwise. If a teammate
  // edits or deletes a rule in another session, an open tab will keep
  // showing stale "already mapped → X" badges until a hard reload. These
  // tests pin down the visibility-driven background refresh.
  // ---------------------------------------------------------------

  describe("scope-rules cache refresh on visibilitychange", () => {
    // Helpers to drive jsdom's visibility state — the property isn't
    // writable normally, so each test redefines it before dispatching.
    const setVisibility = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
    };

    afterEach(() => {
      // Restore the default to "visible" so unrelated tests aren't affected.
      setVisibility("visible");
    });

    it("refetches a stale scoped-rules entry on visibilitychange (visible) and re-hydrates the expanded panel without a loading flicker", async () => {
      const user = userEvent.setup();
      let getCount = 0;
      const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        if (url.includes("/api/field-mapping-rules/suggestions")) {
          return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
        }
        if (url.includes("/api/field-mapping-rules") && method === "GET") {
          getCount++;
          // First fetch: rule maps field_3 → phone. Subsequent fetches
          // (the visibility-driven refresh) return field_3 → email so we
          // can prove the panel re-hydrated from the new server data.
          if (getCount === 1) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }] }),
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ rules: [{ fieldName: "field_3", mapsTo: "email", id: 12 }] }),
          } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      });

      render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["field_3"] })} />);
      await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
      expect(await screen.findByText(/already mapped → phone/)).toBeInTheDocument();

      // Capture the count of scoped GETs after the initial preload.
      const scopedGetCount = () =>
        fetchMock.mock.calls.filter(([u, init]) => {
          const url = typeof u === "string" ? u : (u as URL | Request).toString();
          const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
          return method === "GET"
            && url.includes("/api/field-mapping-rules")
            && !url.includes("/suggestions")
            && url.includes("pageUrlPattern=");
        }).length;
      expect(scopedGetCount()).toBe(1);

      // Step time forward past the freshness window. Use real wall clock —
      // the panel reads Date.now() directly, and using fake timers here
      // would interfere with userEvent's microtask scheduling.
      const realDateNow = Date.now;
      const advancedTo = realDateNow() + SCOPED_RULES_FRESHNESS_WINDOW_MS + 1000;
      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(advancedTo);

      try {
        // Simulate the operator returning to the tab.
        setVisibility("visible");
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });

        // The visibility-driven refresh should have issued exactly one new GET.
        await waitFor(() => {
          expect(scopedGetCount()).toBe(2);
        });

        // The expanded panel should re-hydrate to the updated mapping
        // (phone → email) once the refetch resolves, without ever flipping
        // back to the editable "Map field_3 to" combobox in between (no flicker).
        expect(await screen.findByText(/already mapped → email/)).toBeInTheDocument();
        expect(screen.queryByText(/already mapped → phone/)).not.toBeInTheDocument();
        expect(screen.queryByRole("combobox", { name: "Map field_3 to" })).not.toBeInTheDocument();
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it("does NOT refetch when visibilitychange fires with the page hidden (idle entry stays cached)", async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetchAll({
        rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }],
      });

      render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["field_3"] })} />);
      await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
      expect(await screen.findByText(/already mapped → phone/)).toBeInTheDocument();

      const scopedGetCount = () =>
        fetchMock.mock.calls.filter(([u, init]) => {
          const url = typeof u === "string" ? u : (u as URL | Request).toString();
          const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
          return method === "GET"
            && url.includes("/api/field-mapping-rules")
            && !url.includes("/suggestions")
            && url.includes("pageUrlPattern=");
        }).length;
      expect(scopedGetCount()).toBe(1);

      // Push wall clock past the freshness window to make the entry "stale"
      // by time alone — but the page is hidden, so we expect no refresh.
      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + SCOPED_RULES_FRESHNESS_WINDOW_MS + 1000);

      try {
        setVisibility("hidden");
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });

        // Give any stray microtasks a chance to flush before asserting.
        await new Promise((r) => setTimeout(r, 0));

        // Still exactly one scoped GET — the hidden tab was left alone.
        expect(scopedGetCount()).toBe(1);
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it("surfaces a 'rules updated from another session' hint when the background refresh actually changes a rule for an expanded panel's field, and auto-clears it after the hint window", async () => {
      const user = userEvent.setup();
      let getCount = 0;
      vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        if (url.includes("/api/field-mapping-rules/suggestions")) {
          return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
        }
        if (url.includes("/api/field-mapping-rules") && method === "GET") {
          getCount++;
          if (getCount === 1) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }] }),
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ rules: [{ fieldName: "field_3", mapsTo: "email", id: 12 }] }),
          } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      });

      render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["field_3"] })} />);
      await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
      expect(await screen.findByText(/already mapped → phone/)).toBeInTheDocument();
      // No hint on initial preload — that's not a "background refresh".
      expect(screen.queryByTestId("rules-updated-hint")).not.toBeInTheDocument();

      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + SCOPED_RULES_FRESHNESS_WINDOW_MS + 1000);

      try {
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });

        // The hint shows up once the refresh resolves and the diff is applied.
        const hint = await screen.findByTestId("rules-updated-hint");
        expect(hint).toHaveTextContent(/rules updated from another session/i);
        // And the badge re-hydrates to the new mapping in the same render.
        expect(await screen.findByText(/already mapped → email/)).toBeInTheDocument();
      } finally {
        dateNowSpy.mockRestore();
      }

      // Hint auto-clears after its display window. The setTimeout was
      // scheduled with the real wall clock (before any fake timers were
      // installed), so we wait it out with a real-timer waitFor whose
      // budget exceeds the hint duration.
      await waitFor(
        () => {
          expect(screen.queryByTestId("rules-updated-hint")).not.toBeInTheDocument();
        },
        { timeout: RULES_UPDATED_HINT_DURATION_MS + 1000 },
      );
      // The badge stays — only the hint fades.
      expect(screen.getByText(/already mapped → email/)).toBeInTheDocument();
    });

    it("does NOT show the hint when a background refresh returns the same rules (no real change)", async () => {
      const user = userEvent.setup();
      mockFetchAll({
        rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }],
      });

      render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["field_3"] })} />);
      await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
      expect(await screen.findByText(/already mapped → phone/)).toBeInTheDocument();

      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + SCOPED_RULES_FRESHNESS_WINDOW_MS + 1000);

      try {
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        // Give the refresh promise a chance to settle.
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        // Same data came back → no hint, badge unchanged.
        expect(screen.queryByTestId("rules-updated-hint")).not.toBeInTheDocument();
        expect(screen.getByText(/already mapped → phone/)).toBeInTheDocument();
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it("does NOT show the hint when the only changed field was saved in this session (local write wins, no surprise to flag)", async () => {
      const user = userEvent.setup();
      let getCount = 0;
      vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        if (url.includes("/api/field-mapping-rules/suggestions")) {
          return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
        }
        if (url.includes("/api/field-mapping-rules") && method === "GET") {
          getCount++;
          if (getCount === 1) {
            return { ok: true, status: 200, json: async () => ({ rules: [] }) } as Response;
          }
          // Background refresh: server still doesn't know about the local
          // save, so it returns empty. The diff (snapshot has field_3,
          // result doesn't) flags field_3 as changed — but field_3 is in
          // the in-session save set so the panel must NOT show the hint.
          return { ok: true, status: 200, json: async () => ({ rules: [] }) } as Response;
        }
        if (method === "POST") {
          return { ok: true, status: 200, json: async () => ({ rule: { id: 99 } }) } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      });

      render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["field_3"] })} />);
      await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

      // Save a mapping locally — this puts field_3 into the in-session set.
      const select = await screen.findByRole("combobox", { name: "Map field_3 to" });
      await user.selectOptions(select, "phone");
      await user.click(screen.getByRole("button", { name: /^Save$/ }));
      expect(await screen.findByText(/^mapped → phone/)).toBeInTheDocument();

      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + SCOPED_RULES_FRESHNESS_WINDOW_MS + 1000);

      try {
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        expect(screen.queryByTestId("rules-updated-hint")).not.toBeInTheDocument();
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it("does NOT show the hint when the changed field isn't displayed by this panel (different scope's fields)", async () => {
      const user = userEvent.setup();
      let getCount = 0;
      vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        if (url.includes("/api/field-mapping-rules/suggestions")) {
          return { ok: true, status: 200, json: async () => ({ suggestions: {} }) } as Response;
        }
        if (url.includes("/api/field-mapping-rules") && method === "GET") {
          getCount++;
          if (getCount === 1) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }] }),
            } as Response;
          }
          // Background refresh changed an UNRELATED field (field_99) for
          // the same scope — this panel only displays field_3, so the
          // hint should stay hidden.
          return {
            ok: true,
            status: 200,
            json: async () => ({
              rules: [
                { fieldName: "field_3", mapsTo: "phone", id: 11 },
                { fieldName: "field_99", mapsTo: "name", id: 22 },
              ],
            }),
          } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      });

      render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["field_3"] })} />);
      await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
      expect(await screen.findByText(/already mapped → phone/)).toBeInTheDocument();

      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + SCOPED_RULES_FRESHNESS_WINDOW_MS + 1000);

      try {
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        expect(screen.queryByTestId("rules-updated-hint")).not.toBeInTheDocument();
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it("does NOT refetch when visibilitychange fires before the freshness window has elapsed (entry still fresh)", async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetchAll({
        rules: [{ fieldName: "field_3", mapsTo: "phone", id: 11 }],
      });

      render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["field_3"] })} />);
      await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
      expect(await screen.findByText(/already mapped → phone/)).toBeInTheDocument();

      const scopedGetCount = () =>
        fetchMock.mock.calls.filter(([u, init]) => {
          const url = typeof u === "string" ? u : (u as URL | Request).toString();
          const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
          return method === "GET"
            && url.includes("/api/field-mapping-rules")
            && !url.includes("/suggestions")
            && url.includes("pageUrlPattern=");
        }).length;
      expect(scopedGetCount()).toBe(1);

      // The user briefly switches tabs and comes right back — well within
      // the freshness window. We don't want to hammer the server every
      // time focus changes, so no refetch should be issued.
      setVisibility("visible");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(scopedGetCount()).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // Learned-suggestions cache refresh on visibility change (Task #283).
  //
  // The shared per-tenant `learnedSuggestionsByTenant` cache lives forever
  // otherwise — only invalidated when this same session deletes a rule. If
  // a teammate confirms or prunes learned suggestions in another session,
  // an open tab will keep pre-selecting the stale "learned" target until a
  // hard reload. These tests pin down the visibility-driven background
  // refresh that closes that gap (parallels the scope-rules block above).
  // ---------------------------------------------------------------

  describe("learned-suggestions cache refresh on visibilitychange", () => {
    const setVisibility = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
    };

    afterEach(() => {
      setVisibility("visible");
    });

    it("refetches a stale learned-suggestions entry on visibilitychange (visible) and re-hydrates the panel's pre-selected dropdown without flicker", async () => {
      const user = userEvent.setup();
      let suggestionsGetCount = 0;
      const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        if (url.includes("/api/field-mapping-rules/suggestions")) {
          suggestionsGetCount++;
          // First fetch: tenant has learned `field_3 → phone`. Second fetch
          // (the visibility-driven refresh) returns `field_3 → email` so we
          // can prove the dropdown re-hydrates with the refreshed suggestion.
          if (suggestionsGetCount === 1) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ suggestions: { field_3: "phone" } }),
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ suggestions: { field_3: "email" } }),
          } as Response;
        }
        if (url.includes("/api/field-mapping-rules") && method === "GET") {
          return { ok: true, status: 200, json: async () => ({ rules: [] }) } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      });

      render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["field_3"] })} />);
      await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));

      // Initial pre-selection from the learned suggestion.
      const select = await screen.findByRole("combobox", { name: "Map field_3 to" });
      await waitFor(() => {
        expect((select as HTMLSelectElement).value).toBe("phone");
      });
      expect(await screen.findByText("learned")).toBeInTheDocument();

      const suggestionsCount = () =>
        fetchMock.mock.calls.filter(([u, init]) => {
          const url = typeof u === "string" ? u : (u as URL | Request).toString();
          const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
          return method === "GET" && url.includes("/api/field-mapping-rules/suggestions");
        }).length;
      expect(suggestionsCount()).toBe(1);

      // Step time forward past the freshness window. Use real wall clock —
      // the panel reads Date.now() directly, and using fake timers here
      // would interfere with userEvent's microtask scheduling.
      const advancedTo = Date.now() + LEARNED_SUGGESTIONS_FRESHNESS_WINDOW_MS + 1000;
      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(advancedTo);

      try {
        // Simulate the operator returning to the tab.
        setVisibility("visible");
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });

        // The visibility-driven refresh should issue exactly one new
        // suggestions GET.
        await waitFor(() => {
          expect(suggestionsCount()).toBe(2);
        });

        // The dropdown re-hydrates to the refreshed learned target without
        // flipping into a "no suggestion" state in between.
        await waitFor(() => {
          expect((select as HTMLSelectElement).value).toBe("email");
        });
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it("does NOT refetch learned suggestions when visibilitychange fires with the page hidden (idle entry stays cached)", async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetchAll({
        suggestions: { field_3: "phone" },
      });

      render(<UnmatchedFieldsPanel evt={makeEvent({ fieldNames: ["field_3"] })} />);
      await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
      const select = await screen.findByRole("combobox", { name: "Map field_3 to" });
      await waitFor(() => {
        expect((select as HTMLSelectElement).value).toBe("phone");
      });

      const suggestionsCount = () =>
        fetchMock.mock.calls.filter(([u, init]) => {
          const url = typeof u === "string" ? u : (u as URL | Request).toString();
          const method = ((init as RequestInit | undefined)?.method || "GET").toUpperCase();
          return method === "GET" && url.includes("/api/field-mapping-rules/suggestions");
        }).length;
      expect(suggestionsCount()).toBe(1);

      // Push wall clock past the freshness window to make the entry "stale"
      // by time alone — but the page is hidden, so we expect no refresh.
      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + LEARNED_SUGGESTIONS_FRESHNESS_WINDOW_MS + 1000);

      try {
        setVisibility("hidden");
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });

        // Give any stray microtasks a chance to flush before asserting.
        await new Promise((r) => setTimeout(r, 0));

        // Still exactly one suggestions GET — the hidden tab was left alone.
        expect(suggestionsCount()).toBe(1);
      } finally {
        dateNowSpy.mockRestore();
      }
    });
  });
});

describe("UnmatchedFieldsPanel — rule-rederive-complete subscription", () => {
  type EmitFn = (data: {
    tenantId?: number;
    pageUrlPattern: string;
    formIdentifier: string;
    leadsChanged: number;
    hitLimit: boolean;
    maxLeads: number;
  }) => void;

  function setupNotification(): {
    emit: EmitFn;
    onRuleRederiveComplete: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  } {
    const listeners = new Set<EmitFn>();
    const unsubscribe = vi.fn();
    const onRuleRederiveComplete = vi.fn((cb: EmitFn) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        unsubscribe();
      };
    });
    useOptionalLeadNotificationMock.mockReturnValue({ onRuleRederiveComplete });
    return {
      emit: (data) => listeners.forEach((cb) => cb(data)),
      onRuleRederiveComplete,
      unsubscribe,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    vi.spyOn(global, "fetch").mockReset();
    __resetLearnedSuggestionsCacheForTests();
    useOptionalLeadNotificationMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    __resetLearnedSuggestionsCacheForTests();
    useOptionalLeadNotificationMock.mockReturnValue(null);
  });

  it("surfaces a 'N historical leads re-derived' toast when a matching event arrives after save", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { emit } = setupNotification();
    mockFetchAll({
      onOther: async () => ({ ok: true, status: 200, json: async () => ({ rule: { id: 1 } }) } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);

    toastMock.success.mockClear();
    emit({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      leadsChanged: 12,
      hitLimit: false,
      maxLeads: 500,
    });

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith("12 historical leads re-derived");
    });
  });

  it("uses the singular noun and appends a capped suffix when hitLimit is true", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { emit } = setupNotification();
    mockFetchAll({
      onOther: async () => ({ ok: true, status: 200, json: async () => ({ rule: { id: 1 } }) } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);
    toastMock.success.mockClear();

    emit({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      leadsChanged: 1,
      hitLimit: true,
      maxLeads: 500,
    });

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith("1+ (capped at 500) historical lead re-derived");
    });
  });

  it("ignores rule-rederive events whose scope (tenant/page/form) does not match this panel", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { emit } = setupNotification();
    mockFetchAll({
      onOther: async () => ({ ok: true, status: 200, json: async () => ({ rule: { id: 1 } }) } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);
    toastMock.success.mockClear();

    // Different tenant.
    emit({
      tenantId: 999,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      leadsChanged: 5,
      hitLimit: false,
      maxLeads: 500,
    });
    // Different pageUrlPattern.
    emit({
      tenantId: 42,
      pageUrlPattern: "/different",
      formIdentifier: "contact-form-1",
      leadsChanged: 5,
      hitLimit: false,
      maxLeads: 500,
    });
    // Different formIdentifier.
    emit({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "some-other-form",
      leadsChanged: 5,
      hitLimit: false,
      maxLeads: 500,
    });

    // Give listeners a chance to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(toastMock.success).not.toHaveBeenCalled();

    // The listener is still registered for THIS scope — a subsequent matching
    // event should still fire.
    emit({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      leadsChanged: 7,
      hitLimit: false,
      maxLeads: 500,
    });
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith("7 historical leads re-derived");
    });
  });

  it("does not toast when a matching event reports zero leads changed", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { emit } = setupNotification();
    mockFetchAll({
      onOther: async () => ({ ok: true, status: 200, json: async () => ({ rule: { id: 1 } }) } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);
    toastMock.success.mockClear();

    emit({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      leadsChanged: 0,
      hitLimit: false,
      maxLeads: 500,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("cleans up the listener after the 30s timeout, so a late event no longer fires", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { emit, unsubscribe } = setupNotification();
    mockFetchAll({
      onOther: async () => ({ ok: true, status: 200, json: async () => ({ rule: { id: 1 } }) } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);
    toastMock.success.mockClear();

    expect(unsubscribe).not.toHaveBeenCalled();

    // Advance past the 30s listener-cleanup window.
    await act(async () => {
      vi.advanceTimersByTime(30_001);
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);

    // A late event for this exact scope should now be ignored — the listener
    // was already torn down.
    emit({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      leadsChanged: 9,
      hitLimit: false,
      maxLeads: 500,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("shows a 'couldn't re-derive historical leads' hint with a Retry button when a matching rule-rederive-failed event arrives", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // Wire a combined complete+failed notification context.
    const completeListeners = new Set<EmitFn>();
    const failedListeners = new Set<(d: {
      tenantId?: number;
      pageUrlPattern: string;
      formIdentifier: string;
      reason: string;
    }) => void>();
    const onRuleRederiveComplete = vi.fn((cb: EmitFn) => {
      completeListeners.add(cb);
      return () => completeListeners.delete(cb);
    });
    const onRuleRederiveFailed = vi.fn((cb: (d: {
      tenantId?: number;
      pageUrlPattern: string;
      formIdentifier: string;
      reason: string;
    }) => void) => {
      failedListeners.add(cb);
      return () => failedListeners.delete(cb);
    });
    useOptionalLeadNotificationMock.mockReturnValue({ onRuleRederiveComplete, onRuleRederiveFailed });

    mockFetchAll({
      onOther: async () => ({ ok: true, status: 200, json: async () => ({ rule: { id: 1 } }) } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);

    // Server emits rule-rederive-failed for this exact scope.
    failedListeners.forEach((cb) =>
      cb({
        tenantId: 42,
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form-1",
        reason: "db blew up",
      }),
    );

    const hint = await screen.findByTestId("rederive-error-hint");
    expect(hint).toHaveTextContent(/Couldn't re-derive historical leads/i);
    const retryBtn = within(hint).getByTestId("rederive-retry-button");
    expect(retryBtn).toBeEnabled();

    // Clicking Retry should re-POST to /api/field-mapping-rules with the same
    // scope + last-saved mapping so the backend re-enqueues the fan-out.
    const fetchSpy = vi.spyOn(global, "fetch");
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ rule: { id: 1 } }),
    } as Response);

    await user.click(retryBtn);
    await waitFor(() => {
      const matching = fetchSpy.mock.calls.find(([u]) =>
        typeof u === "string" && u.includes("/api/field-mapping-rules"),
      );
      expect(matching).toBeTruthy();
      const body = JSON.parse((matching![1] as RequestInit).body as string);
      expect(body).toMatchObject({
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form-1",
        fieldName: "field_3",
        mapsTo: "phone",
      });
    });
  });

  it("ignores rule-rederive-failed events whose scope does not match this panel", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const failedListeners = new Set<(d: {
      tenantId?: number;
      pageUrlPattern: string;
      formIdentifier: string;
      reason: string;
    }) => void>();
    const onRuleRederiveFailed = vi.fn((cb: (d: {
      tenantId?: number;
      pageUrlPattern: string;
      formIdentifier: string;
      reason: string;
    }) => void) => {
      failedListeners.add(cb);
      return () => failedListeners.delete(cb);
    });
    useOptionalLeadNotificationMock.mockReturnValue({
      onRuleRederiveComplete: vi.fn(() => () => {}),
      onRuleRederiveFailed,
    });
    mockFetchAll({
      onOther: async () => ({ ok: true, status: 200, json: async () => ({ rule: { id: 1 } }) } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/mapped → phone/);

    // Different scopes — none should surface the hint.
    failedListeners.forEach((cb) =>
      cb({ tenantId: 999, pageUrlPattern: "/contact", formIdentifier: "contact-form-1", reason: "x" }),
    );
    failedListeners.forEach((cb) =>
      cb({ tenantId: 42, pageUrlPattern: "/other", formIdentifier: "contact-form-1", reason: "x" }),
    );
    failedListeners.forEach((cb) =>
      cb({ tenantId: 42, pageUrlPattern: "/contact", formIdentifier: "other-form", reason: "x" }),
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("rederive-error-hint")).not.toBeInTheDocument();
  });

  it("does not register a listener when the notification context is not mounted", async () => {
    // useOptionalLeadNotificationMock defaults to returning null in beforeEach.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockFetchAll({
      onOther: async () => ({ ok: true, status: 200, json: async () => ({ rule: { id: 1 } }) } as Response),
    });

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    // Save still succeeds end-to-end — the panel just degrades to "no
    // historical re-derive indicator", which is exactly the contract
    // useOptionalLeadNotification is designed to provide.
    await screen.findByText(/mapped → phone/);
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/Mapped "field_3" → phone/),
    );
  });
});
