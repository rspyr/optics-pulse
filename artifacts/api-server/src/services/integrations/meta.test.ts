import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MetaAPIService,
  MetaTokenInvalidError,
  MetaApiError,
  updateMetaAdSetBudget,
  sendCAPIEvents,
  buildCAPILeadEvent,
} from "./meta";

const ORIGINAL_FETCH = globalThis.fetch;

function mockResponse(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status });
}

function setFetch(impl: typeof fetch) {
  globalThis.fetch = impl as typeof fetch;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
});

async function runWithTimers<T>(p: Promise<T>): Promise<T> {
  // Attach a no-op catch immediately so a rejection is not flagged as unhandled
  // while we're still advancing fake timers. We re-throw via `await p` below.
  p.catch(() => {});
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
  return p;
}

describe("MetaAPIService — retry on 429/5xx", () => {
  it("retries a 429 response and succeeds on a later attempt", async () => {
    const calls: string[] = [];
    let attempts = 0;
    setFetch(async (url) => {
      calls.push(String(url));
      attempts++;
      if (attempts < 3) {
        return mockResponse(429, { error: { message: "rate limited", code: 4 } });
      }
      return mockResponse(200, { id: "123", name: "Test User" });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_999" });
    const result = await runWithTimers(svc.verifyToken());

    expect(attempts).toBe(3);
    expect(result).toEqual({ id: "123", name: "Test User" });
  });

  it("retries a 500 response", async () => {
    let attempts = 0;
    setFetch(async () => {
      attempts++;
      if (attempts < 2) return mockResponse(500, { error: { message: "boom" } });
      return mockResponse(200, { id: "1" });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    await runWithTimers(svc.verifyToken());

    expect(attempts).toBe(2);
  });

  it("gives up after MAX_RETRIES and throws MetaApiError", async () => {
    let attempts = 0;
    setFetch(async () => {
      attempts++;
      return mockResponse(503, { error: { message: "unavailable" } });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    await expect(runWithTimers(svc.verifyToken())).rejects.toBeInstanceOf(MetaApiError);
    // Initial attempt + MAX_RETRIES (3) = 4 total
    expect(attempts).toBe(4);
  });

  it("does NOT retry a non-transient 4xx (e.g. 400 with no transient flag)", async () => {
    let attempts = 0;
    setFetch(async () => {
      attempts++;
      return mockResponse(400, { error: { message: "bad request", code: 100 } });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    await expect(runWithTimers(svc.verifyToken())).rejects.toBeInstanceOf(MetaApiError);
    expect(attempts).toBe(1);
  });
});

describe("MetaAPIService — AbortController timeout", () => {
  it("aborts a request that exceeds REQUEST_TIMEOUT_MS and retries", async () => {
    let attempts = 0;
    setFetch(async (_url, init) => {
      attempts++;
      const signal = (init as RequestInit | undefined)?.signal;
      if (attempts === 1) {
        // Simulate a request that never resolves and gets aborted.
        return await new Promise<Response>((_resolve, reject) => {
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      }
      return mockResponse(200, { id: "ok" });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    const result = await runWithTimers(svc.verifyToken());

    expect(attempts).toBe(2);
    expect(result).toEqual({ id: "ok" });
  });
});

describe("MetaAPIService — MetaTokenInvalidError mapping", () => {
  it("throws MetaTokenInvalidError for code 190 (token expired) and does NOT retry", async () => {
    let attempts = 0;
    setFetch(async () => {
      attempts++;
      return mockResponse(401, {
        error: {
          message: "Session has expired",
          type: "OAuthException",
          code: 190,
          error_subcode: 463,
        },
      });
    });

    const svc = new MetaAPIService({ accessToken: "expired", adAccountId: "act_1" });
    let caught: unknown;
    try { await runWithTimers(svc.verifyToken()); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(MetaTokenInvalidError);
    const err = caught as MetaTokenInvalidError;
    expect(err.code).toBe(190);
    expect(err.subcode).toBe(463);
    expect(attempts).toBe(1); // never retried
  });

  it("throws MetaTokenInvalidError for OAuthException with a session-invalidation subcode (463)", async () => {
    setFetch(async () => mockResponse(401, {
      error: { message: "Session was invalidated", type: "OAuthException", code: 102, error_subcode: 463 },
    }));

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    await expect(runWithTimers(svc.verifyToken())).rejects.toBeInstanceOf(MetaTokenInvalidError);
  });

  it("does NOT throw MetaTokenInvalidError for OAuthException without code 190 or invalidation subcode", async () => {
    let attempts = 0;
    setFetch(async () => {
      attempts++;
      return mockResponse(403, {
        error: { message: "OAuth error", type: "OAuthException", code: 200 },
      });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    let caught: unknown;
    try { await runWithTimers(svc.verifyToken()); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MetaApiError);
    expect(caught).not.toBeInstanceOf(MetaTokenInvalidError);
    // Non-transient → not retried.
    expect(attempts).toBe(1);
  });

  it("treats OAuthException code 17 (User request limit reached) as transient, NOT a token expiry", async () => {
    let attempts = 0;
    setFetch(async () => {
      attempts++;
      return mockResponse(400, {
        error: { message: "(#17) User request limit reached", type: "OAuthException", code: 17 },
      });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    let caught: unknown;
    try { await runWithTimers(svc.verifyToken()); } catch (e) { caught = e; }
    expect(caught).not.toBeInstanceOf(MetaTokenInvalidError);
    expect(caught).toBeInstanceOf(MetaApiError);
    const err = caught as MetaApiError;
    expect(err.isTransient).toBe(true);
    expect(err.fbCode).toBe(17);
    expect(err.message).toMatch(/User request limit reached/);
    // Retried until MAX_RETRIES (1 initial + 3 retries = 4 total).
    expect(attempts).toBe(4);
  });

  it("treats OAuthException code 4 (Application request limit reached) as transient, NOT a token expiry", async () => {
    let attempts = 0;
    setFetch(async () => {
      attempts++;
      return mockResponse(400, {
        error: { message: "Application request limit reached", type: "OAuthException", code: 4 },
      });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    let caught: unknown;
    try { await runWithTimers(svc.verifyToken()); } catch (e) { caught = e; }
    expect(caught).not.toBeInstanceOf(MetaTokenInvalidError);
    expect(caught).toBeInstanceOf(MetaApiError);
    expect((caught as MetaApiError).isTransient).toBe(true);
    expect((caught as MetaApiError).fbCode).toBe(4);
    expect(attempts).toBe(4);
  });
});

describe("MetaAPIService — budget cache behavior", () => {
  it("caches the daily-budget result and skips a second network call within TTL", async () => {
    let fetchCount = 0;
    setFetch(async () => {
      fetchCount++;
      return mockResponse(200, {
        data: [
          { id: "as_1", name: "Set A", effective_status: "ACTIVE", daily_budget: "5000" },
          { id: "as_2", name: "Set B", effective_status: "ACTIVE", daily_budget: "10000" },
          { id: "as_3", name: "Set C", effective_status: "PAUSED", daily_budget: "1000" },
        ],
      });
    });

    // Use a fresh ad-account id per test to avoid cross-test cache pollution.
    const acct = `act_${Date.now()}_a`;
    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: acct });
    const first = await runWithTimers(svc.getAdAccountDailyBudget());
    const second = await runWithTimers(svc.getAdAccountDailyBudget());

    expect(fetchCount).toBe(1); // second call served from cache
    expect(first.total).toBe(15000); // only ACTIVE sets
    expect(first.details).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it("returns stale cached value when a refresh fetch fails", async () => {
    const acct = `act_${Date.now()}_b`;
    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: acct });

    // First call: succeeds, populates cache.
    let mode: "ok" | "fail" = "ok";
    setFetch(async () => {
      if (mode === "ok") {
        return mockResponse(200, {
          data: [{ id: "x", name: "X", effective_status: "ACTIVE", daily_budget: "777" }],
        });
      }
      return mockResponse(500, { error: { message: "down" } });
    });

    const first = await runWithTimers(svc.getAdAccountDailyBudget());
    expect(first.total).toBe(777);

    // Force cache expiry then fail the refresh.
    mode = "fail";
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const stale = await runWithTimers(svc.getAdAccountDailyBudget());
    expect(stale.total).toBe(777); // returned stale, did not throw
  });

  it("invalidates cache after updateAdSetDailyBudget", async () => {
    const acct = `act_${Date.now()}_c`;
    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: acct });

    let fetchCount = 0;
    setFetch(async (_url, init) => {
      fetchCount++;
      // Update call (POST to /<adset_id>) returns empty success
      if ((init as RequestInit | undefined)?.method === "POST") {
        return mockResponse(200, {});
      }
      return mockResponse(200, {
        data: [{ id: "as_1", name: "A", effective_status: "ACTIVE", daily_budget: "100" }],
      });
    });

    await runWithTimers(svc.getAdAccountDailyBudget());
    const before = fetchCount;
    await runWithTimers(svc.updateAdSetDailyBudget("as_1", 5));
    await runWithTimers(svc.getAdAccountDailyBudget());

    // 1 GET (cache populate) + 1 POST (update) + 1 GET (cache miss after invalidation)
    expect(fetchCount).toBeGreaterThan(before + 1);
  });
});

describe("MetaAPIService.updateAdSetDailyBudget", () => {
  it("converts dollars to cents and POSTs the correct body shape", async () => {
    const captured: { url?: string; method?: string; body?: unknown; contentType?: string } = {};
    setFetch(async (url, init) => {
      const i = init as RequestInit | undefined;
      captured.url = String(url);
      captured.method = i?.method;
      captured.contentType = (i?.headers as Record<string, string> | undefined)?.["Content-Type"];
      captured.body = i?.body ? JSON.parse(String(i.body)) : undefined;
      return mockResponse(200, {});
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_42" });
    await runWithTimers(svc.updateAdSetDailyBudget("as_777", 12.34));

    expect(captured.method).toBe("POST");
    expect(captured.contentType).toBe("application/json");
    expect(captured.url).toContain("/as_777");
    expect(captured.url).toContain("access_token=tok");
    // 12.34 * 100 = 1234 cents (integer)
    expect(captured.body).toEqual({ daily_budget: 1234 });
  });

  it("rounds fractional cents to the nearest integer", async () => {
    let bodySeen: unknown;
    setFetch(async (_url, init) => {
      const i = init as RequestInit | undefined;
      bodySeen = i?.body ? JSON.parse(String(i.body)) : undefined;
      return mockResponse(200, {});
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    // 9.999 * 100 = 999.9 → rounds to 1000
    await runWithTimers(svc.updateAdSetDailyBudget("as_x", 9.999));
    expect(bodySeen).toEqual({ daily_budget: 1000 });
  });

  it("invalidates the budget cache after a successful update", async () => {
    const acct = `act_${Date.now()}_upd`;
    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: acct });

    let getCount = 0;
    setFetch(async (_url, init) => {
      const method = (init as RequestInit | undefined)?.method;
      if (method === "POST") return mockResponse(200, {});
      getCount++;
      return mockResponse(200, {
        data: [{ id: "as_1", name: "A", effective_status: "ACTIVE", daily_budget: "100" }],
      });
    });

    await runWithTimers(svc.getAdAccountDailyBudget());
    expect(getCount).toBe(1);
    // Cached: another get within TTL would be skipped
    await runWithTimers(svc.getAdAccountDailyBudget());
    expect(getCount).toBe(1);

    // Update should clear the cache for this account
    await runWithTimers(svc.updateAdSetDailyBudget("as_1", 5));
    await runWithTimers(svc.getAdAccountDailyBudget());
    expect(getCount).toBe(2); // re-fetched after invalidation
  });
});

describe("updateMetaAdSetBudget (function wrapper)", () => {
  it("delegates to MetaAPIService.updateAdSetDailyBudget with cents conversion", async () => {
    const captured: { url?: string; body?: unknown; method?: string } = {};
    setFetch(async (url, init) => {
      const i = init as RequestInit | undefined;
      captured.url = String(url);
      captured.method = i?.method;
      captured.body = i?.body ? JSON.parse(String(i.body)) : undefined;
      return mockResponse(200, {});
    });

    await runWithTimers(
      updateMetaAdSetBudget(
        { accessToken: "tok2", adAccountId: "act_55" },
        "as_555",
        25,
      ),
    );

    expect(captured.method).toBe("POST");
    expect(captured.url).toContain("/as_555");
    expect(captured.body).toEqual({ daily_budget: 2500 });
  });
});

describe("sendCAPIEvents", () => {
  it("short-circuits with no network call when pixelId is missing", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return mockResponse(200, {});
    });

    const result = await sendCAPIEvents(
      { accessToken: "tok", adAccountId: "act_1" }, // no pixelId
      [buildCAPILeadEvent("hash_em", "hash_ph", 100)],
    );

    expect(calls).toBe(0);
    expect(result).toEqual({ eventsReceived: 0, messages: [] });
  });

  it("short-circuits with no network call when events array is empty", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return mockResponse(200, {});
    });

    const result = await sendCAPIEvents(
      { accessToken: "tok", adAccountId: "act_1", pixelId: "px_999" },
      [],
    );

    expect(calls).toBe(0);
    expect(result).toEqual({ eventsReceived: 0, messages: [] });
  });

  it("POSTs to /<pixelId>/events with { data: events } and returns mapped envelope", async () => {
    const captured: { url?: string; method?: string; body?: unknown } = {};
    setFetch(async (url, init) => {
      const i = init as RequestInit | undefined;
      captured.url = String(url);
      captured.method = i?.method;
      captured.body = i?.body ? JSON.parse(String(i.body)) : undefined;
      return mockResponse(200, { events_received: 2, messages: ["ok"] });
    });

    const ev1 = buildCAPILeadEvent("em_hash", "ph_hash", 250);
    const ev2 = buildCAPILeadEvent("em2", null, 100);
    const result = await sendCAPIEvents(
      { accessToken: "captok", adAccountId: "act_1", pixelId: "px_123" },
      [ev1, ev2],
    );

    expect(captured.method).toBe("POST");
    expect(captured.url).toContain("/px_123/events");
    expect(captured.url).toContain("access_token=captok");
    expect(captured.body).toEqual({ data: [ev1, ev2] });
    expect(result).toEqual({ eventsReceived: 2, messages: ["ok"] });
  });

  it("returns an error envelope (does not throw) when the API call fails", async () => {
    setFetch(async () =>
      mockResponse(400, { error: { message: "Invalid pixel", code: 100 } }),
    );

    const result = await runWithTimers(
      sendCAPIEvents(
        { accessToken: "tok", adAccountId: "act_1", pixelId: "px_bad" },
        [buildCAPILeadEvent("em", "ph", 50)],
      ),
    );

    expect(result.eventsReceived).toBe(0);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/Invalid pixel|400/i);
  });
});

describe("MetaAPIService — insights pagination", () => {
  it("fetchAdDailyInsights aggregates rows across multi-page paging.next responses in order", async () => {
    const pages = [
      {
        data: [
          { ad_id: "a1", date_start: "2026-01-01", date_stop: "2026-01-01", impressions: "10" },
          { ad_id: "a2", date_start: "2026-01-01", date_stop: "2026-01-01", impressions: "20" },
        ],
        paging: { next: "https://graph.facebook.com/v19.0/act_1/insights?after=p2", cursors: { after: "p1" } },
      },
      {
        data: [
          { ad_id: "a3", date_start: "2026-01-02", date_stop: "2026-01-02", impressions: "30" },
          { ad_id: "a4", date_start: "2026-01-02", date_stop: "2026-01-02", impressions: "40" },
        ],
        paging: { next: "https://graph.facebook.com/v19.0/act_1/insights?after=p3", cursors: { after: "p2" } },
      },
      {
        data: [
          { ad_id: "a5", date_start: "2026-01-03", date_stop: "2026-01-03", impressions: "50" },
        ],
        paging: { cursors: { after: "p3" } }, // no next → loop ends
      },
    ];

    let call = 0;
    setFetch(async () => {
      const body = pages[call] || { data: [] };
      call++;
      return mockResponse(200, body);
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    const rows = await runWithTimers(svc.fetchAdDailyInsights("2026-01-01", "2026-01-03"));

    expect(call).toBe(3);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.ad_id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("fetchAdDailyInsights breaks out of the loop when paging.cursors.after repeats (stuck cursor)", async () => {
    let call = 0;
    setFetch(async () => {
      call++;
      // Always return next + the same cursor "stuck" → second iteration should break
      return mockResponse(200, {
        data: [{ ad_id: `row_${call}`, date_start: "2026-01-01", date_stop: "2026-01-01" }],
        paging: {
          next: "https://graph.facebook.com/v19.0/act_1/insights?after=stuck",
          cursors: { after: "stuck" },
        },
      });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    const rows = await runWithTimers(svc.fetchAdDailyInsights("2026-01-01", "2026-01-01"));

    // First call sets lastCursor=stuck; second call sees cursor===lastCursor and breaks before a third fetch.
    expect(call).toBe(2);
    expect(rows.map((r) => r.ad_id)).toEqual(["row_1", "row_2"]);
  });

  it("fetchAdDailyInsights respects the 200-page safety cap when next never terminates", async () => {
    let call = 0;
    setFetch(async () => {
      call++;
      // Always return paging.next with NO cursor so the stuck-cursor guard never triggers.
      // The only thing that should stop the loop is the safety cap.
      return mockResponse(200, {
        data: [{ ad_id: `row_${call}`, date_start: "2026-01-01", date_stop: "2026-01-01" }],
        paging: { next: `https://graph.facebook.com/v19.0/act_1/insights?after=p${call}` },
      });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    const rows = await runWithTimers(svc.fetchAdDailyInsights("2026-01-01", "2026-01-01"));

    expect(call).toBe(200);
    expect(rows).toHaveLength(200);
  });

  it("fetchCampaignDailyInsights aggregates rows across multi-page responses in order", async () => {
    const pages = [
      {
        data: [
          { campaign_id: "c1", campaign_name: "C1", date_start: "2026-01-01", date_stop: "2026-01-01" },
        ],
        paging: { next: "https://graph.facebook.com/v19.0/act_1/insights?after=cp2" },
      },
      {
        data: [
          { campaign_id: "c2", campaign_name: "C2", date_start: "2026-01-02", date_stop: "2026-01-02" },
          { campaign_id: "c3", campaign_name: "C3", date_start: "2026-01-03", date_stop: "2026-01-03" },
        ],
      },
    ];

    let call = 0;
    setFetch(async () => {
      const body = pages[call] || { data: [] };
      call++;
      return mockResponse(200, body);
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    const rows = await runWithTimers(svc.fetchCampaignDailyInsights("2026-01-01", "2026-01-03"));

    expect(call).toBe(2);
    expect(rows.map((r) => r.campaign_id)).toEqual(["c1", "c2", "c3"]);
  });

  it("fetchCampaignDailyInsights breaks out of the loop when paging.cursors.after repeats (stuck cursor)", async () => {
    let call = 0;
    setFetch(async () => {
      call++;
      return mockResponse(200, {
        data: [{ campaign_id: `c_${call}`, date_start: "2026-01-01", date_stop: "2026-01-01" }],
        paging: {
          next: "https://graph.facebook.com/v19.0/act_1/insights?after=stuck",
          cursors: { after: "stuck" },
        },
      });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    const rows = await runWithTimers(svc.fetchCampaignDailyInsights("2026-01-01", "2026-01-01"));

    // First call sets lastCursor=stuck; second call sees cursor===lastCursor and breaks before a third fetch.
    expect(call).toBe(2);
    expect(rows.map((r) => r.campaign_id)).toEqual(["c_1", "c_2"]);
  });

  it("fetchCampaignDailyInsights respects the 200-page safety cap", async () => {
    let call = 0;
    setFetch(async () => {
      call++;
      return mockResponse(200, {
        data: [{ campaign_id: `c_${call}`, date_start: "2026-01-01", date_stop: "2026-01-01" }],
        paging: { next: `https://graph.facebook.com/v19.0/act_1/insights?after=p${call}` },
      });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    const rows = await runWithTimers(svc.fetchCampaignDailyInsights("2026-01-01", "2026-01-01"));

    expect(call).toBe(200);
    expect(rows).toHaveLength(200);
  });
});

describe("MetaAPIService — fetchAdDailyInsights field set (Task #561)", () => {
  it("does NOT include any video_* breakdown fields in the request URL", async () => {
    const capturedUrls: string[] = [];
    setFetch(async (url) => {
      capturedUrls.push(String(url));
      return mockResponse(200, { data: [], paging: {} });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    await runWithTimers(svc.fetchAdDailyInsights("2026-01-01", "2026-01-02"));

    expect(capturedUrls.length).toBeGreaterThan(0);
    const fieldsParam = capturedUrls[0];
    expect(fieldsParam).not.toMatch(/video_play_actions/);
    expect(fieldsParam).not.toMatch(/video_p25_watched_actions/);
    expect(fieldsParam).not.toMatch(/video_p50_watched_actions/);
    expect(fieldsParam).not.toMatch(/video_p75_watched_actions/);
    expect(fieldsParam).not.toMatch(/video_p100_watched_actions/);
    expect(fieldsParam).toMatch(/spend/);
    expect(fieldsParam).toMatch(/impressions/);
    expect(fieldsParam).toMatch(/actions/);
  });
});

describe("MetaAPIService — fetchAdDailyInsightsAsync (Task #561 async report path)", () => {
  it("POSTs the kickoff, polls until Job Completed, then pages the report and returns rows", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let pollCount = 0;
    setFetch(async (url, init) => {
      const i = init as RequestInit | undefined;
      const u = String(url);
      const method = i?.method || "GET";
      calls.push({ url: u, method });

      if (method === "POST" && u.includes("/act_1/insights")) {
        return mockResponse(200, { report_run_id: "rep_42" });
      }
      if (method === "GET" && /\/rep_42\?/.test(u)) {
        pollCount++;
        if (pollCount < 2) {
          return mockResponse(200, { async_status: "Job Running", async_percent_completion: 50 });
        }
        return mockResponse(200, { async_status: "Job Completed", async_percent_completion: 100 });
      }
      if (method === "GET" && /\/rep_42\/insights/.test(u)) {
        return mockResponse(200, {
          data: [
            { ad_id: "a1", date_start: "2026-01-01", date_stop: "2026-01-01", impressions: "10" },
            { ad_id: "a2", date_start: "2026-01-02", date_stop: "2026-01-02", impressions: "20" },
          ],
          paging: { cursors: { after: "p1" } },
        });
      }
      return mockResponse(500, { error: { message: "unexpected route", url: u } });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    const rows = await runWithTimers(
      svc.fetchAdDailyInsightsAsync("2026-01-01", "2026-01-02", { pollIntervalMs: 1000 }),
    );

    expect(rows.map((r) => r.ad_id)).toEqual(["a1", "a2"]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toMatch(/\/act_1\/insights/);
    expect(calls.filter((c) => /\/rep_42\?/.test(c.url)).length).toBe(2);
    expect(calls.filter((c) => /\/rep_42\/insights/.test(c.url)).length).toBe(1);
  });

  it("throws MetaApiError when the async job terminates with Job Failed", async () => {
    setFetch(async (_url, init) => {
      const method = (init as RequestInit | undefined)?.method || "GET";
      if (method === "POST") return mockResponse(200, { report_run_id: "rep_x" });
      return mockResponse(200, { async_status: "Job Failed" });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    let caught: unknown;
    try {
      await runWithTimers(svc.fetchAdDailyInsightsAsync("2026-01-01", "2026-01-02", { pollIntervalMs: 500 }));
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MetaApiError);
    expect((caught as Error).message).toMatch(/Job Failed/);
  });

  it("throws a plain Error (not MetaApiError) when polling exceeds the timeout", async () => {
    setFetch(async (_url, init) => {
      const method = (init as RequestInit | undefined)?.method || "GET";
      if (method === "POST") return mockResponse(200, { report_run_id: "rep_t" });
      return mockResponse(200, { async_status: "Job Running", async_percent_completion: 10 });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    let caught: unknown;
    try {
      await runWithTimers(
        svc.fetchAdDailyInsightsAsync("2026-01-01", "2026-01-02", {
          pollIntervalMs: 1000,
          timeoutMs: 2000,
        }),
      );
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/timed out/);
    expect(caught).not.toBeInstanceOf(MetaApiError);
  });

  it("throws MetaApiError when the kickoff POST returns no report_run_id", async () => {
    setFetch(async (_url, init) => {
      const method = (init as RequestInit | undefined)?.method || "GET";
      if (method === "POST") return mockResponse(200, {});
      return mockResponse(500, {});
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    await expect(
      runWithTimers(svc.fetchAdDailyInsightsAsync("2026-01-01", "2026-01-02")),
    ).rejects.toBeInstanceOf(MetaApiError);
  });
});

describe("MetaAPIService — listing pagination guards", () => {
  it("listAdAccounts aggregates rows across multi-page paging.next responses in order", async () => {
    const pages = [
      {
        data: [
          { id: "act_1", account_id: "1", name: "Account 1", currency: "USD" },
          { id: "act_2", account_id: "2", name: "Account 2", currency: "USD" },
        ],
        paging: { next: "https://graph.facebook.com/v19.0/me/adaccounts?after=p2", cursors: { after: "p1" } },
      },
      {
        data: [
          { id: "act_3", account_id: "3", name: "Account 3", currency: "USD" },
        ],
        paging: { cursors: { after: "p2" } },
      },
    ];
    let call = 0;
    setFetch(async () => {
      const body = pages[call] || { data: [] };
      call++;
      return mockResponse(200, body);
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    const accts = await runWithTimers(svc.listAdAccounts());

    expect(call).toBe(2);
    expect(accts.map((a) => a.id)).toEqual(["act_1", "act_2", "act_3"]);
  });

  it("listAdAccounts breaks out of the loop when paging.cursors.after repeats (stuck cursor)", async () => {
    let call = 0;
    setFetch(async () => {
      call++;
      return mockResponse(200, {
        data: [{ id: `act_${call}`, account_id: String(call), name: `A${call}`, currency: "USD" }],
        paging: {
          next: "https://graph.facebook.com/v19.0/me/adaccounts?after=stuck",
          cursors: { after: "stuck" },
        },
      });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    const accts = await runWithTimers(svc.listAdAccounts());

    // First call sets lastCursor=stuck; second call sees cursor===lastCursor and breaks before a third fetch.
    expect(call).toBe(2);
    expect(accts.map((a) => a.id)).toEqual(["act_1", "act_2"]);
  });

  it("fetchAdSets breaks out of the loop when paging.cursors.after repeats (stuck cursor)", async () => {
    let call = 0;
    setFetch(async () => {
      call++;
      return mockResponse(200, {
        data: [{ id: `as_${call}`, name: `Set ${call}` }],
        paging: {
          next: "https://graph.facebook.com/v19.0/act_1/adsets?after=stuck",
          cursors: { after: "stuck" },
        },
      });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    const sets = await runWithTimers(svc.fetchAdSets());

    expect(call).toBe(2);
    expect(sets.map((s) => s.id)).toEqual(["as_1", "as_2"]);
  });

  it("fetchAds breaks out of the loop when paging.cursors.after repeats (stuck cursor)", async () => {
    let call = 0;
    setFetch(async () => {
      call++;
      return mockResponse(200, {
        data: [{ id: `ad_${call}`, name: `Ad ${call}` }],
        paging: {
          next: "https://graph.facebook.com/v19.0/act_1/ads?after=stuck",
          cursors: { after: "stuck" },
        },
      });
    });

    const svc = new MetaAPIService({ accessToken: "tok", adAccountId: "act_1" });
    const ads = await runWithTimers(svc.fetchAds());

    expect(call).toBe(2);
    expect(ads.map((a) => a.id)).toEqual(["ad_1", "ad_2"]);
  });
});

describe("buildCAPILeadEvent", () => {
  it("builds an event with hashed em/ph, event_time in seconds, and custom_data", () => {
    const at = new Date("2026-01-15T12:00:00.000Z");
    const ev = buildCAPILeadEvent("HASHED_EMAIL", "HASHED_PHONE", 350, at);

    expect(ev.event_name).toBe("Lead");
    expect(ev.action_source).toBe("system_generated");
    // Seconds, not milliseconds
    expect(ev.event_time).toBe(Math.floor(at.getTime() / 1000));
    expect(ev.user_data).toEqual({ em: ["HASHED_EMAIL"], ph: ["HASHED_PHONE"] });
    expect(ev.custom_data).toEqual({
      value: 350,
      currency: "USD",
      content_name: "HVAC Service Lead",
    });
  });

  it("omits em when hashedEmail is null and ph when hashedPhone is null", () => {
    const evNoEmail = buildCAPILeadEvent(null, "PH", 10);
    expect(evNoEmail.user_data).toEqual({ ph: ["PH"] });
    expect(evNoEmail.user_data.em).toBeUndefined();

    const evNoPhone = buildCAPILeadEvent("EM", null, 10);
    expect(evNoPhone.user_data).toEqual({ em: ["EM"] });
    expect(evNoPhone.user_data.ph).toBeUndefined();

    const evNeither = buildCAPILeadEvent(null, null, 10);
    expect(evNeither.user_data).toEqual({});
  });

  it("defaults event_time to now (in seconds) when no Date is provided", () => {
    const fixed = new Date("2026-05-01T00:00:00.000Z");
    vi.setSystemTime(fixed);
    const ev = buildCAPILeadEvent("EM", "PH", 1);
    expect(ev.event_time).toBe(Math.floor(fixed.getTime() / 1000));
  });
});
