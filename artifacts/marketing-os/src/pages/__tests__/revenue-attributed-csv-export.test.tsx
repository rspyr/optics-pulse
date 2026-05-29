// Component coverage for the Revenue Attributed CSV export reconciling with the
// summary cards (Task #703).
//
// The route tests prove the summary aggregate equals the sum of the JSON list
// rows. But the bytes the user actually downloads go through the front-end CSV
// formatter (buildRevenueAttributedCsv), which the route can't see — a
// regression there could let the exported totals drift from the cards with no
// test failing. This file closes that gap end-to-end:
//
//   1. Drive the REAL export path (click "Download CSV") so the actual CSV bytes
//      are produced by the shipped formatter, captured via URL.createObjectURL.
//   2. Parse the downloaded CSV and sum its "Corrected Revenue" / "Rebate
//      Amount" columns, plus attributed revenue (corrected where Match Tier is
//      not "unmatched").
//   3. Assert those totals equal the /summary endpoint totals the cards render
//      for the same range/tenant — i.e. the download can never silently drift
//      from the cards.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { useTenantFilterMock, useAuthMock, toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  useTenantFilterMock: vi.fn(),
  useAuthMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("@/hooks/use-tenant-filter", async () => {
  const { mockUseTenantFilterModule } = await import("@/test-utils/use-tenant-filter-mocks");
  return mockUseTenantFilterModule({
    useTenantFilter: useTenantFilterMock as unknown as typeof import("@/hooks/use-tenant-filter")["useTenantFilter"],
  });
});

vi.mock("@/components/auth-context", async () => {
  const { mockAuthContextModule } = await import("@/test-utils/auth-context-mocks");
  return mockAuthContextModule({
    useAuth: useAuthMock as unknown as typeof import("@/components/auth-context")["useAuth"],
  });
});

vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

import RevenueAttributed, { type RevenueJob } from "../revenue-attributed";
import { makeTenantFilterStub } from "@/test-utils/use-tenant-filter-mocks";
import { makeAuthStub } from "@/test-utils/auth-context-mocks";

const TENANT_ID = 42;
const round2 = (n: number) => Math.round(n * 100) / 100;

// A mixed range of completed jobs the cards and the CSV must agree on:
//   id 1 — invoiced (900 + 150 rebate), attributed (gclid)
//   id 2 — invoiced (500, no rebate), NOT attributed; customer name contains a
//          comma to force CSV quoting (exercises the real escaper)
//   id 3 — legacy fallback to `revenue` (750), attributed (manual)
const exportJobs: RevenueJob[] = [
  {
    id: 1, tenantId: TENANT_ID, stJobId: "ST-1", stInvoiceId: "INV-1",
    customerName: "Acme HVAC", jobType: "install", jobTypeName: "Install",
    status: "completed", revenue: 1000, invoiceTotal: 900, invoiceRebateAmount: 150,
    correctedRevenue: 1050, invoiceDate: "2026-05-01", completedAt: "2026-05-01",
    createdAt: "2026-05-01", matchLevel: "gclid", matchedGclid: "g1",
    rebateBreakdown: [{ label: "ETO", amount: 150 }], soldByName: "Dana", lead: null,
  },
  {
    id: 2, tenantId: TENANT_ID, stJobId: "ST-2", stInvoiceId: "INV-2",
    customerName: "Smith, Bob & Co", jobType: "repair", jobTypeName: "Repair",
    status: "completed", revenue: 500, invoiceTotal: 500, invoiceRebateAmount: null,
    correctedRevenue: 500, invoiceDate: "2026-05-02", completedAt: "2026-05-02",
    createdAt: "2026-05-02", matchLevel: null, matchedGclid: null,
    rebateBreakdown: [], soldByName: null, lead: null,
  },
  {
    id: 3, tenantId: TENANT_ID, stJobId: "ST-3", stInvoiceId: null,
    customerName: "Legacy Co", jobType: "service", jobTypeName: "Service",
    status: "completed", revenue: 750, invoiceTotal: null, invoiceRebateAmount: null,
    correctedRevenue: 750, invoiceDate: null, completedAt: null,
    createdAt: "2026-05-03", matchLevel: "manual", matchedGclid: null,
    rebateBreakdown: [], soldByName: null, lead: null,
  },
];

// The /summary aggregate the server computes for the same range (corrected
// revenue, rebate add-back, attributed-only revenue, count). Derived from the
// same dataset so the test reconciles the CSV against the cards, not a literal.
const summary = {
  revenue: round2(exportJobs.reduce((s, j) => s + j.correctedRevenue, 0)),
  rebates: round2(exportJobs.reduce((s, j) => s + (j.invoiceRebateAmount ?? 0), 0)),
  attributed: round2(
    exportJobs.reduce((s, j) => s + (j.matchLevel != null ? j.correctedRevenue : 0), 0),
  ),
  count: exportJobs.length,
};

// Minimal RFC-4180 line splitter: handles quoted fields with embedded commas
// and escaped ("") quotes, so we can read back exactly what the formatter wrote.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += c;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

let capturedCsv: string | null = null;

function installFetch() {
  vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/drilldown/revenue-attributed/summary")) {
      return { ok: true, status: 200, json: async () => summary } as Response;
    }
    if (url.includes("/api/drilldown/revenue-attributed")) {
      // Both the on-screen page load and the limit=all export hit this; return
      // the full dataset with the X-Total-Count header the UI relies on.
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k === "X-Total-Count" ? "3" : null) },
        json: async () => exportJobs,
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

function setUser() {
  useTenantFilterMock.mockReturnValue(
    makeTenantFilterStub({
      isAgency: true,
      effectiveTenantId: TENANT_ID,
      localTenantId: TENANT_ID,
      tenants: [{ id: TENANT_ID, name: "Acme" }],
    }),
  );
  useAuthMock.mockReturnValue(
    makeAuthStub({
      user: {
        id: 1, email: "agency@acme.test", name: "Agency Op", role: "agency_user",
        tenantId: TENANT_ID, tenantName: "Acme", leaderboardConfig: null,
      },
      isAgency: true,
      isClient: false,
      effectiveTenantId: TENANT_ID,
    }),
  );
}

beforeEach(() => {
  capturedCsv = null;
  useTenantFilterMock.mockReset();
  useAuthMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  // Capture the exact bytes the download would contain (jsdom's Blob has no
  // .text(), so grab the parts the handler passes to the Blob constructor), and
  // neutralise the jsdom-unsupported object-URL + anchor navigation it triggers.
  vi.stubGlobal(
    "Blob",
    class {
      constructor(parts: unknown[]) {
        capturedCsv = (parts ?? []).map((p) => String(p)).join("");
      }
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Revenue Attributed — CSV export reconciles with summary cards (Task #703)", () => {
  it("downloads a CSV whose corrected/rebate/attributed totals equal the summary cards", async () => {
    setUser();
    installFetch();
    const user = userEvent.setup();
    render(<RevenueAttributed />);

    // Wait for the page (and summary cards) to load.
    await screen.findByText("Acme HVAC");

    // Trigger the real export path.
    const downloadBtn = screen.getByRole("button", { name: /download csv/i });
    await user.click(downloadBtn);

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    await waitFor(() => expect(capturedCsv).not.toBeNull());

    const grid = parseCsv(capturedCsv!);
    const header = grid[0];
    const dataRows = grid.slice(1);

    const correctedIdx = header.indexOf("Corrected Revenue");
    const rebateIdx = header.indexOf("Rebate Amount");
    const matchIdx = header.indexOf("Match Tier");
    expect(correctedIdx).toBeGreaterThanOrEqual(0);
    expect(rebateIdx).toBeGreaterThanOrEqual(0);
    expect(matchIdx).toBeGreaterThanOrEqual(0);

    // Every job in the range made it into the export.
    expect(dataRows).toHaveLength(summary.count);

    const csvCorrected = round2(dataRows.reduce((s, r) => s + Number(r[correctedIdx]), 0));
    const csvRebates = round2(dataRows.reduce((s, r) => s + Number(r[rebateIdx]), 0));
    const csvAttributed = round2(
      dataRows.reduce((s, r) => s + (r[matchIdx] !== "unmatched" ? Number(r[correctedIdx]) : 0), 0),
    );

    // The downloaded bytes reconcile with the cards, column for column.
    expect(csvCorrected).toBe(summary.revenue);
    expect(csvRebates).toBe(summary.rebates);
    expect(csvAttributed).toBe(summary.attributed);

    // The comma-containing customer name round-trips intact (escaper works), so
    // the column offsets the totals rely on never shift.
    expect(dataRows.some((r) => r.includes("Smith, Bob & Co"))).toBe(true);
  });
});
