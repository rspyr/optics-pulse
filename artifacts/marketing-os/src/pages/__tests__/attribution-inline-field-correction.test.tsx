import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<typeof import("@workspace/api-client-react")>(
    "@workspace/api-client-react",
  );
  return {
    ...actual,
    useListAttributionEvents: vi.fn(),
    useGetAttributionEvent: vi.fn(),
  };
});

vi.mock("@/hooks/use-tenant-filter", () => ({
  useTenantFilter: vi.fn(() => ({ tenantId: 1, tenantName: "Test" })),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { sonnerToastMock } = vi.hoisted(() => ({
  sonnerToastMock: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: sonnerToastMock,
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

import { InlineFieldCorrection, EditableAutoDetectedFields, FormFieldsList } from "../attribution";
import type { AttributionEvent } from "@workspace/api-client-react";

function makeEvent(formFields: Record<string, unknown>): AttributionEvent {
  return {
    id: 1,
    pageUrl: "https://example.com/contact",
    formFields,
  } as unknown as AttributionEvent;
}

describe("InlineFieldCorrection — captured value rendering", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders (empty) placeholder for empty-string captured values and shows captured-field count in section title", () => {
    const event = makeEvent({ company_url: "", first_name: "Jane" });
    render(<InlineFieldCorrection tenantId={42} event={event} />);

    // Header title contains the section name
    expect(screen.getByText("Inline Field Correction")).toBeInTheDocument();
    // Subtitle in the section header shows captured count
    expect(screen.getByText(/2 fields captured/)).toBeInTheDocument();
    // Empty string value rendered as explicit placeholder, not blank
    expect(screen.getByText("(empty)")).toBeInTheDocument();
    // Non-empty value rendered verbatim
    expect(screen.getByText("Jane")).toBeInTheDocument();
  });

  it("renders objects/arrays as compact JSON and (no value) for null", () => {
    const event = makeEvent({
      meta: { utm_source: "google" },
      tags: ["a", "b"],
      empty_field: null,
    });
    render(<InlineFieldCorrection tenantId={42} event={event} />);

    expect(screen.getByText(/3 fields captured/)).toBeInTheDocument();
    expect(screen.getByText('{"utm_source":"google"}')).toBeInTheDocument();
    expect(screen.getByText('["a","b"]')).toBeInTheDocument();
    expect(screen.getByText("(no value)")).toBeInTheDocument();
  });

  it("filters out _-prefixed internal keys from both the count and the rendered list", () => {
    const event = makeEvent({
      first_name: "Jane",
      _internal_meta: "should-be-hidden",
      _custom: { foo: "bar" },
    });
    render(<InlineFieldCorrection tenantId={42} event={event} />);

    expect(screen.getByText(/1 field captured/)).toBeInTheDocument();
    expect(screen.queryByText("_internal_meta")).not.toBeInTheDocument();
    expect(screen.queryByText("_custom")).not.toBeInTheDocument();
    expect(screen.getByText("first_name")).toBeInTheDocument();
  });

  it("uses singular 'field' wording when exactly one field is captured", () => {
    const event = makeEvent({ first_name: "Jane" });
    render(<InlineFieldCorrection tenantId={42} event={event} />);

    expect(screen.getByText(/1 field captured/)).toBeInTheDocument();
    expect(screen.queryByText(/1 fields captured/)).not.toBeInTheDocument();
  });

  it("renders long captured values with the truncate class so the row stays single-line (full value via title tooltip)", () => {
    const longValue = "a".repeat(500);
    const event = makeEvent({ notes: longValue });
    render(<InlineFieldCorrection tenantId={42} event={event} />);

    const rendered = screen.getByText(longValue);
    expect(rendered).toBeInTheDocument();
    // Inline Field Correction value column truncates with hover tooltip showing the full value.
    expect(rendered.className).toContain("truncate");
    expect(rendered.getAttribute("title")).toBe(longValue);
  });
});

describe("FormFieldsList — captured value rendering in Form Data section", () => {
  it("renders (empty) and (no value) placeholders and shows the captured-field count", () => {
    render(
      <FormFieldsList formFields={{ company_url: "", first_name: "Jane", optional: null }} />
    );

    expect(screen.getByText(/3 fields captured/)).toBeInTheDocument();
    expect(screen.getByText("(empty)")).toBeInTheDocument();
    expect(screen.getByText("Jane")).toBeInTheDocument();
    expect(screen.getByText("(no value)")).toBeInTheDocument();
  });

  it("renders objects/arrays as compact JSON", () => {
    render(
      <FormFieldsList formFields={{ meta: { utm: "google" }, tags: ["a", "b"] }} />
    );

    expect(screen.getByText(/2 fields captured/)).toBeInTheDocument();
    expect(screen.getByText('{"utm":"google"}')).toBeInTheDocument();
    expect(screen.getByText('["a","b"]')).toBeInTheDocument();
  });

  it("filters out _-prefixed internal keys from both the count and the rendered list", () => {
    render(
      <FormFieldsList formFields={{ first_name: "Jane", _custom: "hidden", _meta: { foo: 1 } }} />
    );

    expect(screen.getByText(/1 field captured/)).toBeInTheDocument();
    expect(screen.queryByText("_custom")).not.toBeInTheDocument();
    expect(screen.queryByText("_meta")).not.toBeInTheDocument();
    expect(screen.getByText("first_name")).toBeInTheDocument();
  });

  it("returns null when no formFields or only _-prefixed keys are present", () => {
    const { container: c1 } = render(<FormFieldsList formFields={null} />);
    expect(c1.firstChild).toBeNull();

    const { container: c2 } = render(<FormFieldsList formFields={undefined} />);
    expect(c2.firstChild).toBeNull();

    const { container: c3 } = render(<FormFieldsList formFields={{ _internal: "x" }} />);
    expect(c3.firstChild).toBeNull();
  });
});

// Shared scaffolding for the rule-rederive-complete subscription tests below.
type RederiveEmitFn = (data: {
  tenantId?: number;
  pageUrlPattern: string;
  formIdentifier: string;
  leadsChanged: number;
  hitLimit: boolean;
  maxLeads: number;
}) => void;

function setupRederiveNotification(): {
  emit: RederiveEmitFn;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<RederiveEmitFn>();
  const unsubscribe = vi.fn();
  const onRuleRederiveComplete = vi.fn((cb: RederiveEmitFn) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
      unsubscribe();
    };
  });
  useOptionalLeadNotificationMock.mockReturnValue(makeLeadNotificationStub({ onRuleRederiveComplete }));
  return {
    emit: (data) => listeners.forEach((cb) => cb(data)),
    unsubscribe,
  };
}

describe("InlineFieldCorrection — rule-rederive-complete subscription", () => {
  beforeEach(() => {
    sonnerToastMock.success.mockReset();
    sonnerToastMock.error.mockReset();
    useOptionalLeadNotificationMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useOptionalLeadNotificationMock.mockReturnValue(null);
  });

  async function openAndSave(fieldName: string) {
    // Click the row to start correcting that field.
    const fieldSpan = screen.getByText(fieldName);
    const chipButton = fieldSpan.closest("button");
    if (!chipButton) throw new Error("chip button not found");
    await act(async () => {
      fireEvent.click(chipButton);
    });
    // Select a mapping target.
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "phone" } });
    });
    // Click Save.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    });
  }

  it("surfaces a 'historical leads re-derived' hint + sonner toast when a matching event arrives", async () => {
    const { emit } = setupRederiveNotification();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rule: { id: 1 } }),
    }));

    render(
      <InlineFieldCorrection
        tenantId={42}
        event={{
          id: 9,
          pageUrl: "https://example.com/contact",
          formId: "contact-form-1",
          formFields: { field_3: "555" },
        } as unknown as AttributionEvent}
      />,
    );

    await act(async () => {
      openAndSave("field_3");
    });
    // Let the save promise resolve.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    emit({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      leadsChanged: 7,
      hitLimit: false,
      maxLeads: 500,
    });

    await waitFor(() => {
      expect(sonnerToastMock.success).toHaveBeenCalledWith("7 historical leads re-derived");
      expect(screen.getByText("7 historical leads re-derived")).toBeInTheDocument();
    });
  });

  it("ignores events for a different scope (different page or form)", async () => {
    const { emit } = setupRederiveNotification();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rule: { id: 1 } }),
    }));

    render(
      <InlineFieldCorrection
        tenantId={42}
        event={{
          id: 9,
          pageUrl: "https://example.com/contact",
          formId: "contact-form-1",
          formFields: { field_3: "555" },
        } as unknown as AttributionEvent}
      />,
    );

    await act(async () => {
      openAndSave("field_3");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Wrong tenant.
    emit({
      tenantId: 999,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      leadsChanged: 5,
      hitLimit: false,
      maxLeads: 500,
    });
    // Wrong pageUrlPattern.
    emit({
      tenantId: 42,
      pageUrlPattern: "/other",
      formIdentifier: "contact-form-1",
      leadsChanged: 5,
      hitLimit: false,
      maxLeads: 500,
    });
    // Wrong formIdentifier.
    emit({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "other-form",
      leadsChanged: 5,
      hitLimit: false,
      maxLeads: 500,
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(sonnerToastMock.success).not.toHaveBeenCalled();
    expect(screen.queryByText(/historical leads? re-derived/)).not.toBeInTheDocument();
  });

  it("cleans up the listener after the 30s timeout and ignores a late matching event", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { emit, unsubscribe } = setupRederiveNotification();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rule: { id: 1 } }),
    }));

    render(
      <InlineFieldCorrection
        tenantId={42}
        event={{
          id: 9,
          pageUrl: "https://example.com/contact",
          formId: "contact-form-1",
          formFields: { field_3: "555" },
        } as unknown as AttributionEvent}
      />,
    );

    await openAndSave("field_3");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(unsubscribe).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(30_001);
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    emit({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      leadsChanged: 9,
      hitLimit: false,
      maxLeads: 500,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sonnerToastMock.success).not.toHaveBeenCalled();
  });

  it("does not register a listener when the notification context is not mounted (no-op)", async () => {
    // useOptionalLeadNotificationMock default returns null in beforeEach.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rule: { id: 1 } }),
    }));

    render(
      <InlineFieldCorrection
        tenantId={42}
        event={{
          id: 9,
          pageUrl: "https://example.com/contact",
          formId: "contact-form-1",
          formFields: { field_3: "555" },
        } as unknown as AttributionEvent}
      />,
    );

    await act(async () => {
      openAndSave("field_3");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // No crash, no re-derive toast — the panel just degrades gracefully.
    expect(sonnerToastMock.success).not.toHaveBeenCalled();
  });
});

describe("EditableAutoDetectedFields — rule-rederive-complete subscription", () => {
  beforeEach(() => {
    sonnerToastMock.success.mockReset();
    sonnerToastMock.error.mockReset();
    useOptionalLeadNotificationMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useOptionalLeadNotificationMock.mockReturnValue(null);
  });

  function renderWithClient(ui: React.ReactNode) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  }

  function makeAutoDetectedEvent(): AttributionEvent {
    return {
      id: 9,
      pageUrl: "https://example.com/contact",
      formId: "contact-form-1",
      formName: null,
      detectedMappings: { field_3: { mapsTo: "phone", method: "value_pattern" } },
    } as unknown as AttributionEvent;
  }

  async function saveOverride() {
    // Click the chip to enter edit mode.
    fireEvent.click(screen.getByText("phone"));
    // Select a new mapping value (default first option is fine; pick email explicitly).
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "email" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("surfaces the 'N historical leads re-derived' toast + hint on a matching event", async () => {
    const { emit } = setupRederiveNotification();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rule: { id: 1 } }),
    }));

    renderWithClient(<EditableAutoDetectedFields tenantId={42} event={makeAutoDetectedEvent()} />);
    await saveOverride();

    emit({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      leadsChanged: 3,
      hitLimit: false,
      maxLeads: 500,
    });

    await waitFor(() => {
      expect(sonnerToastMock.success).toHaveBeenCalledWith("3 historical leads re-derived");
    });
    expect(screen.getByText("3 historical leads re-derived")).toBeInTheDocument();
  });

  it("ignores non-matching scopes", async () => {
    const { emit } = setupRederiveNotification();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rule: { id: 1 } }),
    }));

    renderWithClient(<EditableAutoDetectedFields tenantId={42} event={makeAutoDetectedEvent()} />);
    await saveOverride();

    emit({
      tenantId: 42,
      pageUrlPattern: "/different",
      formIdentifier: "contact-form-1",
      leadsChanged: 4,
      hitLimit: false,
      maxLeads: 500,
    });
    emit({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "other-form",
      leadsChanged: 4,
      hitLimit: false,
      maxLeads: 500,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sonnerToastMock.success).not.toHaveBeenCalled();
  });

  it("cleans up the listener after 30s and ignores late events", async () => {
    const { emit, unsubscribe } = setupRederiveNotification();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rule: { id: 1 } }),
    }));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithClient(<EditableAutoDetectedFields tenantId={42} event={makeAutoDetectedEvent()} />);
    await saveOverride();
    expect(unsubscribe).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(30_001);
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    emit({
      tenantId: 42,
      pageUrlPattern: "/contact",
      formIdentifier: "contact-form-1",
      leadsChanged: 10,
      hitLimit: false,
      maxLeads: 500,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sonnerToastMock.success).not.toHaveBeenCalled();
  });
});

// Shared scaffolding for the rule-rederive-FAILED subscription tests below.
type FailedEmitFn = (data: {
  tenantId?: number;
  pageUrlPattern: string;
  formIdentifier: string;
  reason: string;
}) => void;

function setupRederiveBothNotifications(): {
  emitComplete: RederiveEmitFn;
  emitFailed: FailedEmitFn;
} {
  const completeListeners = new Set<RederiveEmitFn>();
  const failedListeners = new Set<FailedEmitFn>();
  const onRuleRederiveComplete = vi.fn((cb: RederiveEmitFn) => {
    completeListeners.add(cb);
    return () => completeListeners.delete(cb);
  });
  const onRuleRederiveFailed = vi.fn((cb: FailedEmitFn) => {
    failedListeners.add(cb);
    return () => failedListeners.delete(cb);
  });
  useOptionalLeadNotificationMock.mockReturnValue(
    makeLeadNotificationStub({ onRuleRederiveComplete, onRuleRederiveFailed }),
  );
  return {
    emitComplete: (d) => completeListeners.forEach((cb) => cb(d)),
    emitFailed: (d) => failedListeners.forEach((cb) => cb(d)),
  };
}

describe("InlineFieldCorrection — rule-rederive-failed subscription", () => {
  beforeEach(() => {
    sonnerToastMock.success.mockReset();
    sonnerToastMock.error.mockReset();
    useOptionalLeadNotificationMock.mockReturnValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useOptionalLeadNotificationMock.mockReturnValue(null);
  });

  async function openAndSave(fieldName: string) {
    const fieldSpan = screen.getByText(fieldName);
    const chipButton = fieldSpan.closest("button");
    if (!chipButton) throw new Error("chip button not found");
    await act(async () => { fireEvent.click(chipButton); });
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await act(async () => { fireEvent.change(select, { target: { value: "phone" } }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Save/ })); });
  }

  it("renders the error hint + Retry button when a matching rule-rederive-failed event arrives", async () => {
    const { emitFailed } = setupRederiveBothNotifications();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ rule: { id: 1 } }) });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <InlineFieldCorrection
        tenantId={42}
        event={{
          id: 9,
          pageUrl: "https://example.com/contact",
          formId: "contact-form-1",
          formFields: { field_3: "555" },
        } as unknown as AttributionEvent}
      />,
    );

    await openAndSave("field_3");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await act(async () => {
      emitFailed({
        tenantId: 42,
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form-1",
        reason: "db blew up",
      });
    });

    const hint = await screen.findByTestId("rederive-error-hint");
    expect(hint).toHaveTextContent(/Couldn't re-derive historical leads/i);
    const retryBtn = screen.getByTestId("rederive-retry-button");

    fetchMock.mockClear();
    await act(async () => { fireEvent.click(retryBtn); });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]: [string]) => typeof u === "string" && u.includes("/api/field-mapping-rules"));
      expect(call).toBeTruthy();
      const body = JSON.parse(call![1].body as string);
      expect(body).toMatchObject({
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form-1",
        fieldName: "field_3",
        mapsTo: "phone",
      });
    });
  });

  it("ignores rule-rederive-failed events whose scope does not match", async () => {
    const { emitFailed } = setupRederiveBothNotifications();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ rule: { id: 1 } }) }));

    render(
      <InlineFieldCorrection
        tenantId={42}
        event={{
          id: 9,
          pageUrl: "https://example.com/contact",
          formId: "contact-form-1",
          formFields: { field_3: "555" },
        } as unknown as AttributionEvent}
      />,
    );
    await openAndSave("field_3");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await act(async () => {
      emitFailed({ tenantId: 999, pageUrlPattern: "/contact", formIdentifier: "contact-form-1", reason: "x" });
      emitFailed({ tenantId: 42, pageUrlPattern: "/other", formIdentifier: "contact-form-1", reason: "x" });
      emitFailed({ tenantId: 42, pageUrlPattern: "/contact", formIdentifier: "other-form", reason: "x" });
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("rederive-error-hint")).not.toBeInTheDocument();
  });
});

describe("EditableAutoDetectedFields — rule-rederive-failed subscription", () => {
  beforeEach(() => {
    sonnerToastMock.success.mockReset();
    sonnerToastMock.error.mockReset();
    useOptionalLeadNotificationMock.mockReturnValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useOptionalLeadNotificationMock.mockReturnValue(null);
  });

  function renderWithClient(ui: React.ReactNode) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  }
  function makeAutoDetectedEvent(): AttributionEvent {
    return {
      id: 9,
      pageUrl: "https://example.com/contact",
      formId: "contact-form-1",
      formName: null,
      detectedMappings: { field_3: { mapsTo: "phone", method: "value_pattern" } },
    } as unknown as AttributionEvent;
  }
  async function saveOverride() {
    fireEvent.click(screen.getByText("phone"));
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "email" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it("renders the error hint + Retry button on a matching rule-rederive-failed event, and Retry re-POSTs the rule", async () => {
    const { emitFailed } = setupRederiveBothNotifications();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ rule: { id: 1 } }) });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<EditableAutoDetectedFields tenantId={42} event={makeAutoDetectedEvent()} />);
    await saveOverride();

    await act(async () => {
      emitFailed({
        tenantId: 42,
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form-1",
        reason: "db blew up",
      });
    });

    const hint = await screen.findByTestId("rederive-error-hint");
    expect(hint).toHaveTextContent(/Couldn't re-derive historical leads/i);

    fetchMock.mockClear();
    await act(async () => { fireEvent.click(screen.getByTestId("rederive-retry-button")); });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]: [string]) => typeof u === "string" && u.includes("/api/field-mapping-rules"));
      expect(call).toBeTruthy();
      const body = JSON.parse(call![1].body as string);
      expect(body).toMatchObject({
        pageUrlPattern: "/contact",
        formIdentifier: "contact-form-1",
        fieldName: "field_3",
        mapsTo: "email",
      });
    });
  });
});
