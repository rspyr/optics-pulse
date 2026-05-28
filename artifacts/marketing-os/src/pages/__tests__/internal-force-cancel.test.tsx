// Coverage for the "Force cancel" escape hatch on the Integration Sync Status
// panel (internal.tsx). Both the historical-backfill card and the revenue-
// recompute card surface a cooperative "Cancel" first, then — only after the
// FORCE_CANCEL_DELAY_MS window has elapsed — a "Force cancel" button that hits
// the cancel route with `?force=true` to hard-flip a stuck run to `cancelled`.
//
// The contract being defended:
//   1. Clicking "Cancel" swaps to a "Cancelling…" state with NO force button
//      yet (it counts down "(force in Ns)" instead).
//   2. After ~8s of wall-clock time the "Force cancel" button appears on its
//      own (driven by the 1Hz tick), without any further sync-status refresh.
//   3. Clicking "Force cancel" POSTs to `/sync-logs/:id/cancel?force=true`.
//   4. Once the next sync-status snapshot reports the run as `cancelled`, the
//      card reflects the hard-cancelled state.
//
// This holds for BOTH the backfill card (service_titan historical backfill)
// and the recompute card (service_titan invoices/estimates phases).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Internal from "../internal";

// ─── Auth + api-client hooks ──────────────────────────────────────────────────

vi.mock("@/components/auth-context", () => ({
  useAuth: () => ({
    selectedTenantId: 42,
    setSelectedTenantId: vi.fn(),
  }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { mockApiClientReactModule, makeApiClientHookStub } = await import(
    "@/test-utils/api-client-react-mocks"
  );
  return mockApiClientReactModule({
    useListTenants: (() => ({
      ...makeApiClientHookStub(),
      data: [{ id: 42, name: "Acme", isActive: true }],
    })) as unknown as typeof import("@workspace/api-client-react").useListTenants,
  });
});

// ─── Sync-status fetch driver ─────────────────────────────────────────────────
//
// internal.tsx fetches `/api/integrations/sync-status` on mount and after every
// cancel. We hand back whichever snapshot is currently queued so a test can
// flip the run from "running" to "cancelled" between refreshes. The cancel POST
// itself returns the forced ack body.

let syncSnapshot: Record<string, unknown>;
let cancelCalls: string[];

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/integrations/sync-logs/") && url.includes("/cancel")) {
      cancelCalls.push(url);
      const forced = url.includes("force=true");
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, forced, message: forced ? "Run hard-cancelled." : "Cancel requested" }),
      } as Response;
    }
    if (url.includes("/api/integrations/sync-status")) {
      return { ok: true, status: 200, json: async () => syncSnapshot } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

function renderInternal() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Internal />
    </QueryClientProvider>,
  );
}

// A sync-status snapshot with the service_titan historical backfill running.
function backfillRunningSnapshot() {
  return {
    statusByIntegration: {
      service_titan: { lastSync: null, lastStatus: "running", lastRecords: 0, errorCount: 0, state: "running" },
    },
    recentLogs: [],
    backfillStatus: {
      service_titan: {
        status: "running",
        recordsProcessed: 10,
        syncLogId: 501,
        cancelRequested: false,
        progress: null,
        startedAt: "2026-05-20T10:00:00Z",
        completedAt: null,
      },
    },
  };
}

function backfillCancelledSnapshot() {
  return {
    statusByIntegration: {
      service_titan: { lastSync: null, lastStatus: "cancelled", lastRecords: 0, errorCount: 0, state: "healthy" },
    },
    recentLogs: [],
    backfillStatus: {
      service_titan: {
        status: "cancelled",
        recordsProcessed: 10,
        syncLogId: 501,
        cancelRequested: true,
        progress: null,
        startedAt: "2026-05-20T10:00:00Z",
        completedAt: "2026-05-20T10:05:00Z",
      },
    },
  };
}

// A snapshot with the revenue recompute running (estimates phase in flight).
function recomputeRunningSnapshot() {
  return {
    statusByIntegration: {
      service_titan: {
        lastSync: null,
        lastStatus: "running",
        lastRecords: 0,
        errorCount: 0,
        state: "running",
        syncTypes: {
          invoices: { lastRun: null, lastStatus: "completed", recordsProcessed: 100, totalRecordsProcessed: 100, runningLogId: null, cancelRequested: false, totalRecords: 100 },
          estimates: { lastRun: null, lastStatus: "running", recordsProcessed: 20, totalRecordsProcessed: 20, runningLogId: 777, cancelRequested: false, totalRecords: 200 },
        },
      },
    },
    recentLogs: [],
    backfillStatus: {},
  };
}

beforeEach(() => {
  cancelCalls = [];
  syncSnapshot = backfillRunningSnapshot();
  vi.stubGlobal("fetch", makeFetchMock());
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Internal — Force cancel escape hatch (backfill card)", () => {
  it("shows Force cancel only after the delay, then POSTs force=true and reflects the cancelled state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    renderInternal();

    // The backfill card renders a cooperative "Cancel" once the running
    // snapshot lands.
    const cancelBtn = await screen.findByRole("button", { name: /^Cancel$/ });

    await user.click(cancelBtn);

    // Immediately after clicking we're "Cancelling…" with the force button
    // gated behind a countdown — not yet clickable.
    await screen.findByText(/Cancelling…/);
    expect(screen.queryByRole("button", { name: /Force cancel/i })).not.toBeInTheDocument();
    expect(screen.getByText(/force in \d+s/i)).toBeInTheDocument();

    // No force POST yet — only the cooperative cancel went out.
    expect(cancelCalls.some((u) => u.includes("force=true"))).toBe(false);
    expect(cancelCalls.some((u) => u.includes("/sync-logs/501/cancel"))).toBe(true);

    // Advance past FORCE_CANCEL_DELAY_MS (8s) so the 1Hz tick reveals the
    // force button on its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8500);
    });

    const forceBtn = await screen.findByRole("button", { name: /Force cancel/i });
    expect(screen.queryByText(/force in \d+s/i)).not.toBeInTheDocument();

    // Next refresh will report the run hard-cancelled.
    syncSnapshot = backfillCancelledSnapshot();
    await user.click(forceBtn);

    // The force path hit the cancel route with force=true on the right log.
    expect(cancelCalls.some((u) => u.includes("/sync-logs/501/cancel?force=true"))).toBe(true);

    // After the post-cancel refresh, the card reflects the cancelled state.
    await waitFor(() => {
      expect(screen.getByText(/^Cancelled$/)).toBeInTheDocument();
    });
  });
});

describe("Internal — Force cancel escape hatch (recompute card)", () => {
  it("shows Force cancel only after the delay, then POSTs force=true for the running phase", async () => {
    syncSnapshot = recomputeRunningSnapshot();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    renderInternal();

    // The recompute card shows its own cooperative Cancel while a phase runs.
    const recomputeCard = (await screen.findByText(/Recompute in progress/i)).closest("div")!.parentElement!;
    const cancelBtn = await within(recomputeCard).findByRole("button", { name: /^Cancel$/ });

    await user.click(cancelBtn);

    await within(recomputeCard).findByText(/Cancelling…/);
    expect(within(recomputeCard).queryByRole("button", { name: /Force cancel/i })).not.toBeInTheDocument();
    expect(within(recomputeCard).getByText(/force in \d+s/i)).toBeInTheDocument();
    expect(cancelCalls.some((u) => u.includes("force=true"))).toBe(false);
    expect(cancelCalls.some((u) => u.includes("/sync-logs/777/cancel"))).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8500);
    });

    const forceBtn = await within(recomputeCard).findByRole("button", { name: /Force cancel/i });
    await user.click(forceBtn);

    expect(cancelCalls.some((u) => u.includes("/sync-logs/777/cancel?force=true"))).toBe(true);
  });
});
