// Coverage for the auto-recompute progress surface on the Settings page
// (settings.tsx, "Rebate Programs Counted as Revenue" card).
//
// When an agency user edits the rebate program list and saves, the server
// fire-and-forgets a historical revenue recompute (ServiceTitan invoices, then
// estimates). The Settings page mirrors that with a progress surface whose
// state logic is non-trivial:
//
//   1. ARM on a *dirty* save — capture each phase's last-completion timestamp
//      (baseline) just before the PATCH so a fresh run can be told apart from a
//      stale earlier one.
//   2. POLL /api/integrations/sync-status every 3s while armed or running and
//      render a per-phase percent bar.
//   3. COMPLETE — once both phases moved past their baseline `lastRun` and
//      nothing is running, resolve to a success note (or a failure note if a
//      phase ended in `error`).
//   4. GRACE WINDOW — if the armed run never starts within ~15s (the edit was a
//      server-side no-op), silently disarm and drop back to the hint text.
//
// The internal admin recompute card is covered by internal-force-cancel.test.tsx;
// this defends the settings surface with the same fake sync-status driver shape.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Settings from "../settings";

// ─── Auth + hook mocks ────────────────────────────────────────────────────────

vi.mock("@/components/auth-context", async () => {
  const { mockAuthContextModule, makeAuthStub } = await import(
    "@/test-utils/auth-context-mocks"
  );
  return mockAuthContextModule({
    useAuth: () =>
      makeAuthStub({
        user: { id: 1, role: "agency_admin", name: "Ada" } as unknown as ReturnType<
          typeof makeAuthStub
        >["user"],
        isAgency: true,
        selectedTenantId: 42,
        effectiveTenantId: 42,
        tenantSelectionMade: true,
      }),
  });
});

vi.mock("@/hooks/use-push-notifications", async () => {
  const { mockUsePushNotificationsModule, makeUsePushNotificationsStub } =
    await import("@/test-utils/use-push-notifications-mocks");
  return mockUsePushNotificationsModule({
    usePushNotifications: () => makeUsePushNotificationsStub(),
  });
});

vi.mock("@workspace/api-client-react", async () => {
  const { mockApiClientReactModule } = await import(
    "@/test-utils/api-client-react-mocks"
  );
  return mockApiClientReactModule();
});

// ─── Sync-status + tenant fetch driver ────────────────────────────────────────
//
// settings.tsx fetches a handful of endpoints on mount (tenant config, comm
// config, podium status, tenants list) plus /api/integrations/sync-status when
// it needs a recompute baseline and on every poll. We hand back whichever
// sync-status snapshot is currently queued so a test can move the run from
// baseline → running → terminal between polls. The rebate PATCH echoes back the
// saved label list the way the real endpoint does.

const OLD_RUN = "2026-05-01T00:00:00Z";
const NEW_RUN = "2026-05-28T12:00:00Z";

let syncSnapshot: Record<string, unknown>;
let patchedRebateLabels: string[];
let patchCalls: Array<{ url: string; body: unknown }>;

type PhaseShape = {
  lastStatus: string;
  recordsProcessed: number;
  totalRecords: number | null;
  lastRun: string | null;
};

function snapshot(invoices: PhaseShape, estimates: PhaseShape) {
  return {
    statusByIntegration: {
      service_titan: {
        syncTypes: { invoices, estimates },
      },
    },
    recentLogs: [],
    backfillStatus: {},
  };
}

// Both phases finished an earlier run — the baseline state captured at save.
function baselineSnapshot() {
  return snapshot(
    { lastStatus: "completed", recordsProcessed: 100, totalRecords: 100, lastRun: OLD_RUN },
    { lastStatus: "completed", recordsProcessed: 200, totalRecords: 200, lastRun: OLD_RUN },
  );
}

// Invoices phase in flight (50/100), estimates not started yet.
function runningSnapshot() {
  return snapshot(
    { lastStatus: "running", recordsProcessed: 50, totalRecords: 100, lastRun: OLD_RUN },
    { lastStatus: "never", recordsProcessed: 0, totalRecords: null, lastRun: OLD_RUN },
  );
}

// Both phases finished a *fresh* run (lastRun moved past the baseline).
function terminalSuccessSnapshot() {
  return snapshot(
    { lastStatus: "completed", recordsProcessed: 100, totalRecords: 100, lastRun: NEW_RUN },
    { lastStatus: "completed", recordsProcessed: 200, totalRecords: 200, lastRun: NEW_RUN },
  );
}

// Fresh run where the estimates phase errored out.
function terminalFailureSnapshot() {
  return snapshot(
    { lastStatus: "completed", recordsProcessed: 100, totalRecords: 100, lastRun: NEW_RUN },
    { lastStatus: "error", recordsProcessed: 40, totalRecords: 200, lastRun: NEW_RUN },
  );
}

function makeFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method || "GET").toUpperCase();
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

    if (url.includes("/api/integrations/sync-status")) {
      return ok(syncSnapshot);
    }
    if (url.includes("/api/leads/comm-config")) {
      return ok({ callReady: false, textReady: false, callStatusMessage: "", textStatusMessage: "" });
    }
    if (url.includes("/api/oauth/podium/status")) {
      return ok({ connected: false });
    }
    // Tracker-health card (renders for every non-client user) needs a valid
    // install-snippet shape or it throws while reading `data.variants`.
    if (url.includes("/api/tracker/install-snippet")) {
      return ok({ tenantName: "Acme", variants: [], suggestedFunnels: [], builderGuidance: [], funnelNote: null });
    }
    if (url.includes("/api/tracker/health-rollup")) {
      return ok({ domains: [] });
    }
    if (url.includes("/api/ingestion-mode/gtm-snippet")) {
      return ok({ snippet: null });
    }
    if (url.includes("/api/ingestion-mode")) {
      return ok({ mode: "sheets" });
    }
    if (url.includes("/api/funnel-aliases")) {
      return ok({ aliases: [] });
    }
    if (url.includes("/funnel-types")) {
      return ok([]);
    }
    // Per-tenant config: GET hydrates the form, PATCH saves it.
    if (/\/api\/tenants\/\d+(\?|$)/.test(url) && !url.includes("/funnel-types")) {
      if (method === "PATCH") {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        patchCalls.push({ url, body });
        if (body?.revenueConfig?.rebateLabels) {
          patchedRebateLabels = body.revenueConfig.rebateLabels;
        }
        return ok({ revenueConfig: { rebateLabels: patchedRebateLabels, usingDefaults: false } });
      }
      return ok({
        serviceTitanId: "",
        loadableConfig: {},
        communicationConfig: { callPlatform: "native", textPlatform: "native" },
        revenueConfig: { rebateLabels: ["ETO"], usingDefaults: false },
      });
    }
    // Tenants list (useTenants) and anything else: harmless defaults.
    if (url.endsWith("/api/tenants") || url.endsWith("/tenants")) {
      return ok([{ id: 42, name: "Acme" }]);
    }
    return ok({});
  });
}

function renderSettings() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Settings />
    </QueryClientProvider>,
  );
}

// Open the collapsible "API Integrations" card (the rebate editor lives inside
// it) and add a new rebate label so the list is dirty.
async function openCardAndDirtyTheList(user: ReturnType<typeof userEvent.setup>) {
  const toggle = await screen.findByRole("button", { name: /API Integrations/i });
  await user.click(toggle);

  const input = await screen.findByPlaceholderText(/PGE Rebate/i);
  await user.click(input);
  await user.type(input, "PGE Rebate");
  // The rebate input and its "Add" button are siblings; scope to that row so
  // we don't collide with the funnel-alias "Add" button elsewhere on the page.
  const addBtn = within(input.parentElement!).getByRole("button", { name: /^Add$/ });
  await user.click(addBtn);

  return screen.getByRole("button", { name: /Save Rebate Programs/i });
}

beforeEach(() => {
  syncSnapshot = baselineSnapshot();
  patchedRebateLabels = ["ETO", "PGE Rebate"];
  patchCalls = [];
  vi.stubGlobal("fetch", makeFetchMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Settings — rebate-edit recompute progress surface", () => {
  it("arms after a dirty save and renders per-phase percent bars while running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });

    renderSettings();

    const saveBtn = await openCardAndDirtyTheList(user);
    await user.click(saveBtn);

    // PATCH carried the updated rebate list.
    await waitFor(() => {
      expect(patchCalls.some((c) => Array.isArray((c.body as { revenueConfig?: { rebateLabels?: unknown } })?.revenueConfig?.rebateLabels))).toBe(true);
    });

    // The progress surface arms immediately after the dirty save.
    await screen.findByText(/Recomputing historical revenue…/i);

    // Move the run into flight, then let a poll land.
    syncSnapshot = runningSnapshot();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });

    // The invoices phase renders a percent bar driven by rows / total. These
    // strings only appear inside the recompute surface, so screen-level
    // queries are unambiguous.
    await waitFor(() => {
      expect(screen.getByText(/50 \/ ~100 \(50%\)/)).toBeInTheDocument();
    });
    // The estimates phase is queued (not yet running).
    expect(screen.getByText(/^queued$/)).toBeInTheDocument();
  });

  it("resolves to the success note once both phases finish fresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });

    renderSettings();

    const saveBtn = await openCardAndDirtyTheList(user);
    await user.click(saveBtn);

    await screen.findByText(/Recomputing historical revenue…/i);

    // Run starts…
    syncSnapshot = runningSnapshot();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });
    await screen.findByText(/50 \/ ~100 \(50%\)/);

    // …then both phases land fresh terminal rows.
    syncSnapshot = terminalSuccessSnapshot();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Revenue recompute complete/i),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/Recomputing historical revenue…/i)).not.toBeInTheDocument();
  });

  it("shows the failure note when a phase ends in error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });

    renderSettings();

    const saveBtn = await openCardAndDirtyTheList(user);
    await user.click(saveBtn);

    await screen.findByText(/Recomputing historical revenue…/i);

    syncSnapshot = runningSnapshot();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });
    await screen.findByText(/50 \/ ~100 \(50%\)/);

    syncSnapshot = terminalFailureSnapshot();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });

    await waitFor(() => {
      expect(screen.getByText(/Revenue recompute failed/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Recomputing historical revenue…/i)).not.toBeInTheDocument();
  });

  it("clears via the grace window when no recompute ever starts (no-op edit)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });

    renderSettings();

    const saveBtn = await openCardAndDirtyTheList(user);
    await user.click(saveBtn);

    // Armed, but the server never actually started a run — snapshot stays at
    // the baseline (no phase ever flips to "running").
    await screen.findByText(/Recomputing historical revenue…/i);

    // Past the ~15s grace window the surface silently disarms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(18000);
    });

    await waitFor(() => {
      expect(
        screen.queryByText(/Recomputing historical revenue…/i),
      ).not.toBeInTheDocument();
    });
    // Back to the idle hint text, with no success/failure note.
    expect(
      screen.getByText(/Saving a changed list automatically re-applies it/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Revenue recompute complete/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Revenue recompute failed/i)).not.toBeInTheDocument();
  });
});
