import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@workspace/api-client-react", () => ({
  useListAttributionEvents: vi.fn(),
  useGetAttributionEvent: vi.fn(),
}));

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

import { InlineFieldCorrection } from "../attribution";
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
});
