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
  deriveMappingScope,
  UnmatchedFieldsPanel,
  type UnmatchedFieldsPanelEvent,
} from "../unmatched-fields-panel";

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rule: { id: 1 } }),
    } as Response);

    render(<UnmatchedFieldsPanel evt={makeEvent()} />);
    await user.click(screen.getByRole("button", { name: /Why unmatched\?/ }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Map field_3 to" }),
      "phone",
    );
    // The new UX requires an explicit Save click after selecting a target,
    // so the operator can confirm the (possibly heuristic-suggested) value.
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
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
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "mapsTo must be one of: phone, email" }),
    } as Response);

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
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
    } as Response);

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
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

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
});
