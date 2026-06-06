import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SERVICE_TITAN_ESTIMATE_STATUSES,
  clearTokenCache,
  fetchSoldEstimates,
  type STEstimate,
} from "./service-titan";

function estimate(id: number, status: string, active = true): STEstimate {
  return {
    id,
    jobId: 2000 + id,
    name: `${status} estimate ${id}`,
    status: { name: status, value: id },
    summary: "Install option",
    followUpOn: null,
    soldBy: null,
    soldOn: status === "Sold" ? "2026-06-01T00:00:00Z" : null,
    subtotal: 1000 + id,
    total: 1000 + id,
    items: [],
    modifiedOn: "2026-06-01T00:00:00Z",
    active,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  clearTokenCache();
  vi.restoreAllMocks();
});

describe("fetchSoldEstimates", () => {
  it("fetches each requested estimate status and de-duplicates estimate ids", async () => {
    const estimateRequests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("auth.servicetitan.io")) {
        return jsonResponse({ access_token: "token", expires_in: 3600 });
      }

      estimateRequests.push(url);
      const parsed = new URL(url);
      const status = parsed.searchParams.get("status") ?? "all";
      if (status === "Sold") {
        return jsonResponse({ data: [estimate(1, "Sold"), estimate(2, "Sold")], page: 1, pageSize: 50, totalCount: 2, hasMore: false });
      }
      if (status === "Open") {
        return jsonResponse({ data: [estimate(2, "Open"), estimate(3, "Open")], page: 1, pageSize: 50, totalCount: 2, hasMore: false });
      }
      if (status === "Dismissed") {
        return jsonResponse({ data: [estimate(4, "Dismissed", false), estimate(5, "Dismissed")], page: 1, pageSize: 50, totalCount: 2, hasMore: false });
      }
      return jsonResponse({ data: [], page: 1, pageSize: 50, totalCount: 0, hasMore: false });
    });

    const batches: STEstimate[][] = [];
    const totals: number[] = [];
    await fetchSoldEstimates(
      { clientId: "client", clientSecret: "secret", tenantId: "tenant", appKey: "app-key" },
      "2026-06-01T00:00:00.000Z",
      async (batch) => { batches.push(batch); },
      (total) => { totals.push(total); },
      { status: SERVICE_TITAN_ESTIMATE_STATUSES },
    );

    const fetchedStatuses = estimateRequests.map((requestUrl) => new URL(requestUrl).searchParams.get("status"));
    expect(fetchedStatuses).toEqual(["Sold", "Open", "Dismissed"]);
    expect(estimateRequests.every((requestUrl) => new URL(requestUrl).searchParams.get("modifiedOnOrAfter") === "2026-06-01T00:00:00.000Z")).toBe(true);
    expect(totals).toEqual([2, 4, 6]);
    expect(batches.flat().map((est) => est.id)).toEqual([1, 2, 3, 5]);
  });
});
