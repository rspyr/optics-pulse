import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  SelectedLeadsRederiveCompleteData,
  SelectedLeadsRederiveFailedData,
} from "@/contexts/lead-notification-context";

type CompleteCb = (data: SelectedLeadsRederiveCompleteData) => void;
type FailedCb = (data: SelectedLeadsRederiveFailedData) => void;

const { completeListeners, failedListeners, useLeadNotificationMock } = vi.hoisted(() => {
  const completeListeners = new Set<CompleteCb>();
  const failedListeners = new Set<FailedCb>();
  const noop = () => () => {};
  return {
    completeListeners,
    failedListeners,
    useLeadNotificationMock: vi.fn(() => ({
      onSelectedLeadsRederiveComplete: (cb: CompleteCb) => {
        completeListeners.add(cb);
        return () => {
          completeListeners.delete(cb);
        };
      },
      onSelectedLeadsRederiveFailed: (cb: FailedCb) => {
        failedListeners.add(cb);
        return () => {
          failedListeners.delete(cb);
        };
      },
      // Other context callbacks the sheet subscribes to during queued
      // re-derives. We don't drive any of them from the tests yet, so a
      // no-op unsubscribe is sufficient — what matters is that the sheet's
      // useEffect doesn't blow up calling an undefined function.
      onSelectedLeadsRederiveProgress: noop,
      onReconnect: noop,
    })),
  };
});

vi.mock("@/contexts/lead-notification-context", () => ({
  useLeadNotification: useLeadNotificationMock,
}));

import { PendingRederiveLeadsSheet } from "../pending-rederive-leads-sheet";

type PendingLead = {
  id: number;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  funnelId: number | null;
  leadType: string | null;
  serviceType: string | null;
  createdAt: string;
  updatedAt: string;
};

function makeLead(id: number, overrides: Partial<PendingLead> = {}): PendingLead {
  return {
    id,
    firstName: `First${id}`,
    lastName: `Last${id}`,
    phone: `555-000${id}`,
    email: null,
    funnelId: null,
    leadType: null,
    serviceType: null,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function emitComplete(data: SelectedLeadsRederiveCompleteData) {
  for (const cb of Array.from(completeListeners)) cb(data);
}
function emitFailed(data: SelectedLeadsRederiveFailedData) {
  for (const cb of Array.from(failedListeners)) cb(data);
}

function mockFetch(opts: {
  leads?: PendingLead[];
  hitLimit?: boolean;
  rederive: (body: { tenantId: number; leadIds: number[] }) => unknown;
}) {
  const leads = opts.leads ?? [];
  const hitLimit = opts.hitLimit ?? false;
  return vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method || "GET").toUpperCase();
    if (url.includes("/pending-rederive-leads")) {
      return { ok: true, status: 200, json: async () => ({ leads, hitLimit }) } as Response;
    }
    if (method === "POST" && url.includes("/field-mapping-rules/rederive-leads")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const result = opts.rederive(body);
      return { ok: true, status: 200, json: async () => result } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
}

const defaultProps = {
  open: true,
  onOpenChange: () => {},
  tenantId: 42,
  pageUrlPattern: "/contact",
  formIdentifier: "form-1",
};

async function renderSheetAndSelectAll(leads: PendingLead[]) {
  const user = userEvent.setup();
  render(<PendingRederiveLeadsSheet {...defaultProps} />);
  await screen.findByTestId("pending-leads-list");
  // Sanity: each lead row rendered
  for (const l of leads) {
    expect(screen.getByTestId(`pending-lead-row-${l.id}`)).toBeInTheDocument();
  }
  await user.click(screen.getByTestId("pending-leads-select-all"));
  return user;
}

describe("PendingRederiveLeadsSheet", () => {
  beforeEach(() => {
    completeListeners.clear();
    failedListeners.clear();
    vi.spyOn(global, "fetch").mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders the sync result and removes successful leads, narrowing selection to failures", async () => {
    const leads = [makeLead(1), makeLead(2), makeLead(3)];
    mockFetch({
      leads,
      rederive: ({ leadIds }) => ({
        mode: "sync",
        total: leadIds.length,
        succeeded: leadIds.length - 1,
        failed: 1,
        changed: leadIds.length - 1,
        failedLeadIds: [2],
      }),
    });

    const user = await renderSheetAndSelectAll(leads);
    await user.click(screen.getByTestId("pending-leads-rederive-selected"));

    const result = await screen.findByTestId("pending-leads-bulk-result");
    expect(result).toHaveTextContent("Re-derived 2/3 leads");
    expect(result).toHaveTextContent("2 updated");
    expect(result).toHaveTextContent("1 failed");

    // Successful leads removed from the visible list, failed one (id=2) stays.
    await waitFor(() => {
      expect(screen.queryByTestId("pending-lead-row-1")).not.toBeInTheDocument();
      expect(screen.queryByTestId("pending-lead-row-3")).not.toBeInTheDocument();
    });
    const failedRow = screen.getByTestId("pending-lead-row-2");
    expect(failedRow).toBeInTheDocument();

    // Selection should now be narrowed to just the failed lead — its checkbox is checked.
    const failedCheckbox = within(failedRow).getByTestId("pending-lead-checkbox-2");
    expect(failedCheckbox).toHaveAttribute("data-state", "checked");
  });

  it("queued + completion event renders final counts", async () => {
    const leads = [makeLead(1), makeLead(2)];
    mockFetch({
      leads,
      rederive: ({ leadIds }) => ({ mode: "queued", total: leadIds.length, jobId: 101 }),
    });

    const user = await renderSheetAndSelectAll(leads);
    await user.click(screen.getByTestId("pending-leads-rederive-selected"));

    const running = await screen.findByTestId("pending-leads-bulk-result");
    expect(running).toHaveTextContent(/Re-deriving 2 leads in the background/);

    await act(async () => {
      emitComplete({
        tenantId: 42,
        jobId: 101,
        total: 2,
        succeeded: 2,
        failed: 0,
        changed: 2,
        failedLeadIds: [],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("pending-leads-bulk-result")).toHaveTextContent("Re-derived 2/2 leads");
    });
    expect(screen.getByTestId("pending-leads-bulk-result")).toHaveTextContent("2 updated");
    expect(screen.queryByTestId("pending-leads-bulk-job-error")).not.toBeInTheDocument();
  });

  it("sync partial failure surfaces the per-lead failure reason on the failed row", async () => {
    const leads = [makeLead(1), makeLead(2), makeLead(3)];
    mockFetch({
      leads,
      rederive: ({ leadIds }) => ({
        mode: "sync",
        total: leadIds.length,
        succeeded: leadIds.length - 1,
        failed: 1,
        changed: leadIds.length - 1,
        failedLeadIds: [2],
        failedLeadErrors: { 2: "No matching funnel rule" },
      }),
    });

    const user = await renderSheetAndSelectAll(leads);
    await user.click(screen.getByTestId("pending-leads-rederive-selected"));

    await screen.findByTestId("pending-leads-bulk-result");
    const reasonEl = await screen.findByTestId("pending-lead-failure-reason-2");
    expect(reasonEl).toHaveTextContent(/Failed: No matching funnel rule/);
  });

  it("queued partial failure surfaces per-lead failure reasons from the complete event", async () => {
    const leads = [makeLead(1), makeLead(2), makeLead(3)];
    mockFetch({
      leads,
      rederive: ({ leadIds }) => ({ mode: "queued", total: leadIds.length, jobId: 909 }),
    });

    const user = await renderSheetAndSelectAll(leads);
    await user.click(screen.getByTestId("pending-leads-rederive-selected"));

    await act(async () => {
      emitComplete({
        tenantId: 42,
        jobId: 909,
        total: 3,
        succeeded: 1,
        failed: 2,
        changed: 1,
        failedLeadIds: [2, 3],
        failedLeadErrors: { 2: "Phone normalization failed", 3: "Lead not found" },
      });
    });

    const reason2 = await screen.findByTestId("pending-lead-failure-reason-2");
    expect(reason2).toHaveTextContent(/Failed: Phone normalization failed/);
    const reason3 = screen.getByTestId("pending-lead-failure-reason-3");
    expect(reason3).toHaveTextContent(/Failed: Lead not found/);
    expect(screen.queryByTestId("pending-lead-failure-reason-1")).not.toBeInTheDocument();
  });

  it("queued partial failure without a reason map shows a no-reason fallback", async () => {
    const leads = [makeLead(1), makeLead(2)];
    mockFetch({
      leads,
      rederive: ({ leadIds }) => ({ mode: "queued", total: leadIds.length, jobId: 910 }),
    });

    const user = await renderSheetAndSelectAll(leads);
    await user.click(screen.getByTestId("pending-leads-rederive-selected"));

    await act(async () => {
      emitComplete({
        tenantId: 42,
        jobId: 910,
        total: 2,
        succeeded: 1,
        failed: 1,
        changed: 1,
        failedLeadIds: [2],
      });
    });

    const reason = await screen.findByTestId("pending-lead-failure-reason-2");
    expect(reason).toHaveTextContent(/Failed \(no reason reported\)/);
  });

  it("queued + partial failure shows failed count and highlights failed rows", async () => {
    const leads = [makeLead(1), makeLead(2), makeLead(3)];
    mockFetch({
      leads,
      rederive: ({ leadIds }) => ({ mode: "queued", total: leadIds.length, jobId: 202 }),
    });

    const user = await renderSheetAndSelectAll(leads);
    await user.click(screen.getByTestId("pending-leads-rederive-selected"));

    await act(async () => {
      emitComplete({
        tenantId: 42,
        jobId: 202,
        total: 3,
        succeeded: 2,
        failed: 1,
        changed: 2,
        failedLeadIds: [3],
      });
    });

    const result = await screen.findByTestId("pending-leads-bulk-result");
    expect(result).toHaveTextContent("Re-derived 2/3 leads");
    expect(result).toHaveTextContent("1 failed");
    // failed row gets a red border (highlight)
    expect(screen.getByTestId("pending-lead-row-3").className).toMatch(/red-500/);
    // non-failed rows do not
    expect(screen.getByTestId("pending-lead-row-1").className).not.toMatch(/red-500/);
  });

  it("ignores complete events with a different jobId (no state corruption)", async () => {
    const leads = [makeLead(1), makeLead(2)];
    mockFetch({
      leads,
      rederive: () => ({ mode: "queued", total: 2, jobId: 555 }),
    });

    const user = await renderSheetAndSelectAll(leads);
    await user.click(screen.getByTestId("pending-leads-rederive-selected"));
    await screen.findByTestId("pending-leads-bulk-result");

    // A different tenant/job's complete event arrives — must NOT update our sheet.
    await act(async () => {
      emitComplete({
        tenantId: 42,
        jobId: 999,
        total: 7,
        succeeded: 7,
        failed: 0,
        changed: 7,
        failedLeadIds: [],
      });
    });

    expect(screen.getByTestId("pending-leads-bulk-result")).toHaveTextContent(
      /Re-deriving 2 leads in the background/,
    );

    // A matching complete event still updates the sheet.
    await act(async () => {
      emitComplete({
        tenantId: 42,
        jobId: 555,
        total: 2,
        succeeded: 2,
        failed: 0,
        changed: 1,
        failedLeadIds: [],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("pending-leads-bulk-result")).toHaveTextContent("Re-derived 2/2 leads");
    });
  });

  it("ignores failed events with a different jobId", async () => {
    const leads = [makeLead(1)];
    mockFetch({
      leads,
      rederive: () => ({ mode: "queued", total: 1, jobId: 100 }),
    });

    const user = await renderSheetAndSelectAll(leads);
    await user.click(screen.getByTestId("pending-leads-rederive-selected"));
    await screen.findByTestId("pending-leads-bulk-result");

    await act(async () => {
      emitFailed({ tenantId: 42, jobId: 200, total: 1, reason: "other-job blew up" });
    });

    expect(screen.queryByTestId("pending-leads-bulk-job-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("pending-leads-bulk-result")).toHaveTextContent(
      /Re-deriving 1 leads in the background/,
    );
  });

  it("queued + failed event surfaces the retry button with the failure reason", async () => {
    const leads = [makeLead(1), makeLead(2)];
    mockFetch({
      leads,
      rederive: () => ({ mode: "queued", total: 2, jobId: 303 }),
    });

    const user = await renderSheetAndSelectAll(leads);
    await user.click(screen.getByTestId("pending-leads-rederive-selected"));

    await act(async () => {
      emitFailed({ tenantId: 42, jobId: 303, total: 2, reason: "worker crashed" });
    });

    const errBox = await screen.findByTestId("pending-leads-bulk-job-error");
    expect(errBox).toHaveTextContent(/Background re-derive failed: worker crashed/);
    expect(screen.getByTestId("pending-leads-bulk-retry")).toBeInTheDocument();
  });

  it("safety timeout surfaces the retry button when no event arrives within 5 minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const leads = [makeLead(1)];
    mockFetch({
      leads,
      rederive: () => ({ mode: "queued", total: 1, jobId: 404 }),
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    render(<PendingRederiveLeadsSheet {...defaultProps} />);
    await screen.findByTestId("pending-leads-list");
    await user.click(screen.getByTestId("pending-leads-select-all"));
    await user.click(screen.getByTestId("pending-leads-rederive-selected"));
    await screen.findByTestId("pending-leads-bulk-result");

    expect(screen.queryByTestId("pending-leads-bulk-job-error")).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 10);
    });

    const errBox = await screen.findByTestId("pending-leads-bulk-job-error");
    expect(errBox).toHaveTextContent(/Timed out waiting for background job to finish/);
    expect(screen.getByTestId("pending-leads-bulk-retry")).toBeInTheDocument();
  });

  it("retry button re-submits the current selection", async () => {
    const leads = [makeLead(1), makeLead(2)];
    const rederive = vi.fn((body: { leadIds: number[] }) => {
      if (rederive.mock.calls.length === 1) {
        return { mode: "queued", total: body.leadIds.length, jobId: 700 };
      }
      return {
        mode: "sync",
        total: body.leadIds.length,
        succeeded: body.leadIds.length,
        failed: 0,
        changed: body.leadIds.length,
        failedLeadIds: [],
      };
    });
    mockFetch({ leads, rederive });

    const user = await renderSheetAndSelectAll(leads);
    await user.click(screen.getByTestId("pending-leads-rederive-selected"));

    await act(async () => {
      emitFailed({ tenantId: 42, jobId: 700, total: 2, reason: "boom" });
    });

    const retry = await screen.findByTestId("pending-leads-bulk-retry");
    await user.click(retry);

    await waitFor(() => {
      expect(rederive).toHaveBeenCalledTimes(2);
    });
    expect(rederive.mock.calls[1][0].leadIds).toEqual([1, 2]);

    // After the retry's sync success, all submitted leads were successful so
    // the list empties out and the sheet returns to its empty state.
    await waitFor(() => {
      expect(screen.getByTestId("pending-leads-empty")).toBeInTheDocument();
    });
  });

  it("retry button uses the current (narrowed) selection, not the original submission", async () => {
    const leads = [makeLead(1), makeLead(2)];
    const rederive = vi.fn((body: { leadIds: number[] }) => {
      if (rederive.mock.calls.length === 1) {
        return { mode: "queued", total: body.leadIds.length, jobId: 808 };
      }
      return {
        mode: "sync",
        total: body.leadIds.length,
        succeeded: body.leadIds.length,
        failed: 0,
        changed: 0,
        failedLeadIds: [],
      };
    });
    mockFetch({ leads, rederive });

    const user = await renderSheetAndSelectAll(leads);
    // Deselect lead 1 so only lead 2 remains selected before submission.
    await user.click(screen.getByTestId("pending-lead-checkbox-1"));
    await user.click(screen.getByTestId("pending-leads-rederive-selected"));

    expect(rederive).toHaveBeenCalledTimes(1);
    expect(rederive.mock.calls[0][0].leadIds).toEqual([2]);

    await act(async () => {
      emitFailed({ tenantId: 42, jobId: 808, total: 1, reason: "boom" });
    });

    const retry = await screen.findByTestId("pending-leads-bulk-retry");
    await user.click(retry);

    await waitFor(() => {
      expect(rederive).toHaveBeenCalledTimes(2);
    });
    expect(rederive.mock.calls[1][0].leadIds).toEqual([2]);
  });
});
