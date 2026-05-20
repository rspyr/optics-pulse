// End-to-end coverage for the Maintenance tab's default-funnel backfill panel
// added in task #582. The backend service (`backfillDefaultFunnelForTenant`)
// has unit coverage and the route (`POST /api/admin/backfill-default-funnel/
// :tenantId`) has route coverage, but the two-step UI flow — dry-run summary
// rendering, the "0 candidates" disabled state, the window.confirm prompt,
// and the write-mode summary swap — had none until this test.
//
// The contract being defended:
//   1. Clicking "Run dry run" POSTs `{ dryRun: true }` to the backfill route
//      and renders the dry-run summary numbers (candidate / cleared / leads)
//      with the "Dry run — no changes written" header.
//   2. Clicking the confirm button shows window.confirm; only on accept does
//      the panel POST `{ dryRun: false }` and swap to the write-mode summary
//      ("Cleanup complete").
//   3. When the dry run returns `candidateEvents: 0` the confirm button is
//      replaced by a disabled "0 candidates" pill — the idempotent rerun
//      case after a successful cleanup.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TenantMaintenance } from "../admin-tenants";

type BackfillResult = {
  tenantId: number;
  defaultFunnelName: string | null;
  candidateEvents: number;
  clearedEvents: number;
  clearedLeads: number;
  leadsSkippedDueToOverride: number;
  leadsSkippedDueToLaterMatch: number;
  dryRun: boolean;
};

function makeResult(overrides: Partial<BackfillResult> = {}): BackfillResult {
  return {
    tenantId: 42,
    defaultFunnelName: "General",
    candidateEvents: 12,
    clearedEvents: 12,
    clearedLeads: 5,
    leadsSkippedDueToOverride: 2,
    leadsSkippedDueToLaterMatch: 1,
    dryRun: true,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  confirmSpy = vi.spyOn(window, "confirm");
});

afterEach(() => {
  vi.unstubAllGlobals();
  confirmSpy.mockRestore();
  vi.restoreAllMocks();
});

function queueResponse(body: BackfillResult, init: { ok?: boolean; status?: number } = {}) {
  fetchMock.mockResolvedValueOnce({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response);
}

describe("TenantMaintenance — default-funnel backfill panel (Task #582)", () => {
  it("runs a dry run, shows summary numbers, confirms, then renders the write-mode summary", async () => {
    const user = userEvent.setup();
    queueResponse(makeResult({ dryRun: true, candidateEvents: 12, clearedEvents: 12, clearedLeads: 5 }));
    queueResponse(makeResult({ dryRun: false, candidateEvents: 12, clearedEvents: 12, clearedLeads: 5 }));
    confirmSpy.mockReturnValue(true);

    render(<TenantMaintenance tenantId={42} apiBase="/marketing-os" />);

    await user.click(screen.getByRole("button", { name: /run dry run/i }));

    // 1. Dry-run summary header + numbers.
    await screen.findByText(/dry run — no changes written/i);
    expect(screen.getByText("General")).toBeInTheDocument();
    const candidateRow = screen.getByText("Candidate events").closest("div");
    expect(candidateRow).not.toBeNull();
    expect(candidateRow!.querySelector("dd")?.textContent).toBe("12");
    expect(screen.getByText("Events that would clear").closest("div")!.querySelector("dd")?.textContent).toBe("12");
    expect(screen.getByText("Leads that would reset").closest("div")!.querySelector("dd")?.textContent).toBe("5");
    expect(screen.getByText("Leads skipped (override)").closest("div")!.querySelector("dd")?.textContent).toBe("2");

    // Dry run posted dryRun:true.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [dryUrl, dryInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(dryUrl).toBe("/marketing-os/api/admin/backfill-default-funnel/42");
    expect(dryInit.method).toBe("POST");
    expect(JSON.parse(dryInit.body as string)).toEqual({ dryRun: true });

    // 2. Click Confirm, accept window.confirm, expect write-mode summary.
    const confirmBtn = await screen.findByRole("button", { name: /confirm.*clear 12 event/i });
    await user.click(confirmBtn);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/12 event\(s\)/);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/5 lead\(s\)/);

    await screen.findByText(/cleanup complete/i);
    // Header swapped — dry-run header gone.
    expect(screen.queryByText(/dry run — no changes written/i)).not.toBeInTheDocument();
    // Write-mode labels (no "would") replace the dry-run labels.
    expect(screen.getByText("Events cleared")).toBeInTheDocument();
    expect(screen.getByText("Leads reset")).toBeInTheDocument();
    expect(screen.queryByText("Events that would clear")).not.toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, writeInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(writeInit.body as string)).toEqual({ dryRun: false });
  });

  it("does NOT POST again when the operator cancels the window.confirm prompt", async () => {
    const user = userEvent.setup();
    queueResponse(makeResult({ dryRun: true, candidateEvents: 3, clearedEvents: 3, clearedLeads: 1 }));
    confirmSpy.mockReturnValue(false);

    render(<TenantMaintenance tenantId={42} apiBase="/marketing-os" />);

    await user.click(screen.getByRole("button", { name: /run dry run/i }));
    await screen.findByText(/dry run — no changes written/i);

    await user.click(screen.getByRole("button", { name: /confirm.*clear 3 event/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // dry run only — no write
    expect(screen.queryByText(/cleanup complete/i)).not.toBeInTheDocument();
  });

  it("renders the disabled '0 candidates' pill when the dry run returns no candidates (idempotent rerun)", async () => {
    const user = userEvent.setup();
    queueResponse(
      makeResult({
        dryRun: true,
        candidateEvents: 0,
        clearedEvents: 0,
        clearedLeads: 0,
        leadsSkippedDueToOverride: 0,
        leadsSkippedDueToLaterMatch: 0,
      }),
    );

    render(<TenantMaintenance tenantId={42} apiBase="/marketing-os" />);

    await user.click(screen.getByRole("button", { name: /run dry run/i }));

    await screen.findByText(/dry run — no changes written/i);

    // The "0 candidates" pill is rendered as a disabled <button>.
    const zeroPill = await screen.findByRole("button", { name: /0 candidates/i });
    expect(zeroPill).toBeDisabled();

    // No confirm button should be rendered — there's nothing to confirm.
    expect(screen.queryByRole("button", { name: /confirm.*clear/i })).not.toBeInTheDocument();

    // The summary still reports the zero counts.
    expect(screen.getByText("Candidate events").closest("div")!.querySelector("dd")?.textContent).toBe("0");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
