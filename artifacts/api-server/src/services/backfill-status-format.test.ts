import { describe, it, expect } from "vitest";
import { parseBackfillProgress, classifyBackfillError, computeChunkPercent } from "./backfill-status-format";

describe("computeChunkPercent", () => {
  it("returns null when totalChunks is non-positive", () => {
    expect(computeChunkPercent(1, 0)).toBeNull();
    expect(computeChunkPercent(1, -1)).toBeNull();
  });

  it("falls back to the chunk-ordinal estimate when no sub-chunk progress is reported", () => {
    // Same values the parser test asserts: (2-1)/13 → 8, (1-1)/4 → 0, (4-1)/4 → 75.
    expect(computeChunkPercent(2, 13)).toBe(8);
    expect(computeChunkPercent(1, 4)).toBe(0);
    expect(computeChunkPercent(4, 4)).toBe(75);
    // null/undefined record counts behave the same as omitting them.
    expect(computeChunkPercent(2, 13, null, null)).toBe(8);
    expect(computeChunkPercent(2, 13, 5, null)).toBe(8);
    expect(computeChunkPercent(2, 13, null, 100)).toBe(8);
  });

  it("advances the percent WITHIN a chunk as chunkRecords increases", () => {
    // Chunk 1 of 4 spans [0%, 25%]. As rows of this chunk land, percent climbs
    // through that band instead of sitting at the 0% chunk-start value.
    const atStart = computeChunkPercent(1, 4, 0, 200); // 0 + 0/200 of 25%
    const quarter = computeChunkPercent(1, 4, 50, 200); // 0.25 of 25% = 6.25 → 6
    const half = computeChunkPercent(1, 4, 100, 200); // 0.5 of 25% = 12.5 → 13
    const almost = computeChunkPercent(1, 4, 200, 200); // full chunk = 25%

    expect(atStart).toBe(0);
    expect(quarter).toBe(6);
    expect(half).toBe(13);
    expect(almost).toBe(25);
    // Strictly increasing as more rows of the chunk are processed.
    expect(atStart).toBeLessThan(quarter!);
    expect(quarter).toBeLessThan(half!);
    expect(half).toBeLessThan(almost!);
  });

  it("keeps sub-chunk progress inside the current chunk's band (mid-run chunk)", () => {
    // Chunk 3 of 4 spans [50%, 75%]. Half the chunk's rows → 50% + 0.5*25% = 62.5 → 63.
    expect(computeChunkPercent(3, 4, 0, 80)).toBe(50);
    expect(computeChunkPercent(3, 4, 40, 80)).toBe(63);
    expect(computeChunkPercent(3, 4, 80, 80)).toBe(75);
  });

  it("clamps the in-chunk fraction to [0, 1] and the result to [0, 100]", () => {
    // Defensive: chunkRecords exceeding chunkTotalRecords can't push past the
    // chunk's upper band, and a final chunk can't exceed 100.
    expect(computeChunkPercent(4, 4, 999, 100)).toBe(100); // last chunk, over-count → 100
    expect(computeChunkPercent(2, 4, -10, 100)).toBe(25); // negative → fraction 0 → (2-1)/4
  });
});

describe("parseBackfillProgress", () => {
  it("returns null for empty / null input", () => {
    expect(parseBackfillProgress(null)).toBeNull();
    expect(parseBackfillProgress(undefined)).toBeNull();
    expect(parseBackfillProgress("")).toBeNull();
    expect(parseBackfillProgress("   ")).toBeNull();
  });

  it("parses 'chunk N/M: YYYY-MM-DD → YYYY-MM-DD' (the writer's actual format)", () => {
    const got = parseBackfillProgress("chunk 2/13: 2025-04-01 → 2025-04-30");
    expect(got).toEqual({
      raw: "chunk 2/13: 2025-04-01 → 2025-04-30",
      kind: "chunk",
      currentChunk: 2,
      totalChunks: 13,
      windowStart: "2025-04-01",
      windowEnd: "2025-04-30",
      // (2-1)/13 = 7.69% → 8
      percent: 8,
      partialReason: null,
      phase: null,
    });
  });

  it("computes 0% on chunk 1 and clamps last chunk under 100", () => {
    expect(parseBackfillProgress("chunk 1/4: 2025-01-01 → 2025-01-31")?.percent).toBe(0);
    expect(parseBackfillProgress("chunk 4/4: 2025-04-01 → 2025-04-30")?.percent).toBe(75);
  });

  it("accepts ASCII '->' as a fallback arrow (defensive)", () => {
    const got = parseBackfillProgress("chunk 1/2: 2025-01-01 -> 2025-01-31");
    expect(got?.kind).toBe("chunk");
    expect(got?.totalChunks).toBe(2);
  });

  it("classifies 'partial: <inner>' as partial with the inner reason extracted", () => {
    const got = parseBackfillProgress("partial: Google Ads API quota exceeded");
    expect(got).toEqual({
      raw: "partial: Google Ads API quota exceeded",
      kind: "partial",
      currentChunk: null,
      totalChunks: null,
      windowStart: null,
      windowEnd: null,
      percent: null,
      partialReason: "Google Ads API quota exceeded",
      phase: null,
    });
  });

  it("falls back to 'other' for unknown shapes", () => {
    const got = parseBackfillProgress("Some freeform error message");
    expect(got?.kind).toBe("other");
    expect(got?.currentChunk).toBeNull();
  });
});

describe("classifyBackfillError", () => {
  it("returns null for empty input", () => {
    expect(classifyBackfillError(null)).toBeNull();
    expect(classifyBackfillError("")).toBeNull();
  });

  it("classifies rate-limit / quota errors", () => {
    const got = classifyBackfillError("Google Ads API quota exceeded");
    expect(got?.code).toBe("rate_limit");
    expect(got?.message).toMatch(/rate-limited|quota/i);
    expect(got?.suggestedAction).toMatch(/wait|smaller/i);
    expect(got?.partial).toBe(false);
  });

  it("classifies Meta Graph user/app rate-limit phrasing as rate_limit (not expired_credentials)", () => {
    expect(classifyBackfillError("User request limit reached")?.code).toBe("rate_limit");
    expect(classifyBackfillError("(#17) User request limit reached")?.code).toBe("rate_limit");
    expect(classifyBackfillError("Application request limit reached")?.code).toBe("rate_limit");
    expect(classifyBackfillError("(#4) Application request limit reached")?.code).toBe("rate_limit");
  });

  it("classifies expired credentials (401 / invalid_grant / token expired)", () => {
    expect(classifyBackfillError("ServiceTitan API error (401): unauthorized")?.code).toBe("expired_credentials");
    expect(classifyBackfillError("invalid_grant")?.code).toBe("expired_credentials");
    expect(classifyBackfillError("Meta token expired")?.code).toBe("expired_credentials");
  });

  it("classifies permission denied / 403", () => {
    expect(classifyBackfillError("ServiceTitan API error (403): forbidden")?.code).toBe("permission_denied");
    expect(classifyBackfillError("PERMISSION_DENIED")?.code).toBe("permission_denied");
  });

  it("classifies upstream 5xx server errors", () => {
    expect(classifyBackfillError("ServiceTitan API 500")?.code).toBe("upstream_server_error");
    expect(classifyBackfillError("Bad Gateway")?.code).toBe("upstream_server_error");
  });

  it("classifies timeouts and network errors", () => {
    expect(classifyBackfillError("ETIMEDOUT")?.code).toBe("timeout");
    expect(classifyBackfillError("fetch failed")?.code).toBe("network");
  });

  describe("timeout classification", () => {
    const cases = [
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "Error: ETIMEDOUT connect timeout",
      "request timeout",
      "the request timed out after 30s",
      "deadline exceeded while awaiting headers",
      "ServiceTitan API error (504): Gateway Timeout",
    ];
    for (const raw of cases) {
      it(`classifies "${raw}" as timeout with the retry-smaller-range hint`, () => {
        const got = classifyBackfillError(raw);
        expect(got?.code).toBe("timeout");
        expect(got?.message).toBe("The upstream API timed out.");
        expect(got?.suggestedAction).toBe(
          "Retry with a smaller day range so each chunk finishes faster.",
        );
        expect(got?.partial).toBe(false);
      });
    }

    it("preserves the partial flag and prefixes the timeout message", () => {
      const got = classifyBackfillError("partial: ETIMEDOUT");
      expect(got?.code).toBe("timeout");
      expect(got?.partial).toBe(true);
      expect(got?.message).toBe("Partial backfill: The upstream API timed out.");
      expect(got?.suggestedAction).toBe(
        "Retry with a smaller day range so each chunk finishes faster.",
      );
    });
  });

  describe("network classification", () => {
    const cases = [
      "ECONNRESET",
      "Error: socket hang up",
      "ECONNREFUSED 127.0.0.1:443",
      "getaddrinfo ENOTFOUND graph.facebook.com",
      "EAI_AGAIN graph.facebook.com",
      "TypeError: fetch failed",
      "network error while contacting upstream",
    ];
    for (const raw of cases) {
      it(`classifies "${raw}" as network with the transient-retry hint`, () => {
        const got = classifyBackfillError(raw);
        expect(got?.code).toBe("network");
        expect(got?.message).toBe("Network error talking to the upstream API.");
        expect(got?.suggestedAction).toBe(
          "Retry in a moment. Persistent failures usually clear within a few minutes.",
        );
        expect(got?.partial).toBe(false);
      });
    }

    it("preserves the partial flag and prefixes the network message", () => {
      const got = classifyBackfillError("partial: ECONNRESET");
      expect(got?.code).toBe("network");
      expect(got?.partial).toBe(true);
      expect(got?.message).toBe(
        "Partial backfill: Network error talking to the upstream API.",
      );
    });
  });

  describe("upstream_server_error classification", () => {
    const cases = [
      "ServiceTitan API 500",
      "ServiceTitan API error (500): Internal Server Error",
      "Google Ads API (502): Bad Gateway",
      "Bad Gateway",
      "503 Service Unavailable",
      "service unavailable",
      "Internal Server Error",
    ];
    for (const raw of cases) {
      it(`classifies "${raw}" as upstream_server_error with the upstream-wait hint`, () => {
        const got = classifyBackfillError(raw);
        expect(got?.code).toBe("upstream_server_error");
        expect(got?.message).toBe("The upstream API returned a server error.");
        expect(got?.suggestedAction).toBe(
          "This is on the upstream provider. Wait a few minutes and retry.",
        );
        expect(got?.partial).toBe(false);
      });
    }

    it("preserves the partial flag and prefixes the upstream-5xx message", () => {
      const got = classifyBackfillError("partial: ServiceTitan API 502");
      expect(got?.code).toBe("upstream_server_error");
      expect(got?.partial).toBe(true);
      expect(got?.message).toBe(
        "Partial backfill: The upstream API returned a server error.",
      );
    });
  });

  it("classifies operator-actionable cases (not configured / paused / already running / tenant)", () => {
    expect(classifyBackfillError("Google Ads not configured (missing Customer ID)")?.code).toBe("not_configured");
    expect(classifyBackfillError("ServiceTitan sync is paused for this tenant")?.code).toBe("paused");
    expect(classifyBackfillError("Another Google Ads sync is already running for this tenant")?.code).toBe("already_running");
    expect(classifyBackfillError("Tenant not found")?.code).toBe("tenant_not_found");
  });

  it("unwraps 'partial: …' and sets the partial flag + prefixes the message", () => {
    const got = classifyBackfillError("partial: Google Ads API quota exceeded");
    expect(got?.code).toBe("rate_limit");
    expect(got?.partial).toBe(true);
    expect(got?.message).toMatch(/^Partial backfill:/);
    expect(got?.raw).toBe("partial: Google Ads API quota exceeded");
  });

  it("falls back to 'unknown' with a generic action for unrecognized text", () => {
    const got = classifyBackfillError("totally novel error string");
    expect(got?.code).toBe("unknown");
    expect(got?.suggestedAction).toMatch(/retry/i);
  });
});
