const META_GRAPH_BASE = "https://graph.facebook.com/v21.0";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BUDGET_CACHE_TTL_MS = 15 * 60 * 1000;

export interface MetaConfig {
  accessToken: string;
  adAccountId: string;
  pixelId?: string;
}

export class MetaTokenInvalidError extends Error {
  readonly code: number;
  readonly subcode?: number;
  constructor(message: string, code: number, subcode?: number) {
    super(message);
    this.name = "MetaTokenInvalidError";
    this.code = code;
    this.subcode = subcode;
  }
}

export class MetaApiError extends Error {
  readonly status: number;
  readonly fbCode?: number;
  readonly isTransient: boolean;
  constructor(message: string, status: number, fbCode: number | undefined, isTransient: boolean) {
    super(message);
    this.name = "MetaApiError";
    this.status = status;
    this.fbCode = fbCode;
    this.isTransient = isTransient;
  }
}

interface MetaErrorEnvelope {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
    fbtrace_id?: string;
  };
}

// Meta returns `type: "OAuthException"` for several distinct conditions —
// genuine token-invalid (code 190 + session-invalidation subcodes) AND
// rate-limit codes (4, 17, 32, 613). Only the former should flip
// `metaNeedsReconnect`; the latter are transient throttles.
const META_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613]);
const META_SESSION_INVALIDATION_SUBCODES: ReadonlySet<number> = new Set([
  458, 459, 460, 463, 464, 467,
]);

function isOAuthExpired(envelope: MetaErrorEnvelope): boolean {
  const e = envelope.error;
  if (!e) return false;
  // Genuine token-invalid: code 190 (any subcode) always counts.
  if (e.code === 190) return true;
  // For other OAuthException responses, only treat them as expiry when the
  // subcode is in the documented session-invalidation set. Rate-limit codes
  // (4, 17, 32, 613) come back with type=OAuthException too but the token
  // is still valid — those must NOT trigger a reconnect.
  if (e.type === "OAuthException") {
    if (typeof e.code === "number" && META_RATE_LIMIT_CODES.has(e.code)) return false;
    if (typeof e.error_subcode === "number" && META_SESSION_INVALIDATION_SUBCODES.has(e.error_subcode)) {
      return true;
    }
    return false;
  }
  return false;
}

function isTransientError(envelope: MetaErrorEnvelope, status: number): boolean {
  if (status === 429 || status >= 500) return true;
  const e = envelope.error;
  if (e?.is_transient === true) return true;
  // Meta rate-limit OAuthExceptions (user/app/page/API call limits) are
  // transient — back off and retry rather than failing hard.
  if (e?.type === "OAuthException" && typeof e.code === "number" && META_RATE_LIMIT_CODES.has(e.code)) {
    return true;
  }
  if (e?.message && /temporarily unavailable|please try again|service is unavailable/i.test(e.message)) return true;
  return false;
}

function parseEnvelope(text: string): MetaErrorEnvelope {
  try { return JSON.parse(text) as MetaErrorEnvelope; } catch { return {}; }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseNumericField(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function parseIntField(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : 0;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

const CONVERSION_ACTION_TYPES = new Set([
  "lead",
  "onsite_conversion.lead_grouped",
  "leadgen.other",
  "offsite_conversion.fb_pixel_lead",
  "offsite_conversion.fb_pixel_complete_registration",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "submit_application",
  "complete_registration",
  "schedule",
  "contact",
]);

export interface MetaAction { action_type: string; value: string }

export function sumConversionActions(actions: MetaAction[] | undefined | null): number {
  if (!actions) return 0;
  let total = 0;
  for (const a of actions) {
    if (CONVERSION_ACTION_TYPES.has(a.action_type)) {
      total += parseIntField(a.value);
    }
  }
  return total;
}

export interface MetaVideoAction { action_type: string; value: string }
interface MetaInsightRow {
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  campaign_id: string;
  campaign_name?: string;
  date_start: string;
  date_stop: string;
  impressions?: string;
  clicks?: string;
  spend?: string;
  cpm?: string;
  actions?: MetaAction[];
  video_play_actions?: MetaAction[];
  video_p25_watched_actions?: MetaAction[];
  video_p50_watched_actions?: MetaAction[];
  video_p75_watched_actions?: MetaAction[];
  video_p100_watched_actions?: MetaAction[];
}

interface MetaInsightsResponse {
  data: MetaInsightRow[];
  paging?: { next?: string; cursors?: { before?: string; after?: string } };
}

export interface MetaAdAccountInfo {
  id: string;        // act_XXXX
  account_id: string; // numeric
  name: string;
  currency: string;
}

export interface MetaCampaignDailyAggregate {
  externalId: string;
  name: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  currency?: string;
  actions: MetaAction[];
}

export interface MetaAdDailyRow {
  adAccountId: string;
  adExternalId: string;
  adName: string;
  campaignExternalId: string;
  campaignName: string;
  adSetExternalId?: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  currency?: string;
  actions: MetaAction[];
}

interface BudgetCacheEntry {
  total: number;
  details: Array<{ adSetId: string; name: string; dailyBudgetCents: number; effectiveStatus: string }>;
  fetchedAt: number;
}

const dailyBudgetCache = new Map<string, BudgetCacheEntry>();

export class MetaAPIService {
  private accessToken: string;
  private adAccountId: string;
  private pixelId?: string;

  constructor(config: MetaConfig) {
    if (!config.accessToken) throw new Error("MetaAPIService: accessToken required");
    this.accessToken = config.accessToken;
    this.adAccountId = config.adAccountId
      ? (config.adAccountId.startsWith("act_") ? config.adAccountId : `act_${config.adAccountId}`)
      : "";
    this.pixelId = config.pixelId;
  }

  /** Build a Graph URL with access_token attached as a query param. */
  private buildUrl(path: string, params?: Record<string, string>): string {
    const fullPath = path.startsWith("http") ? path : `${META_GRAPH_BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const url = new URL(fullPath);
    if (!url.searchParams.has("access_token")) {
      url.searchParams.set("access_token", this.accessToken);
    }
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    return url.toString();
  }

  private async request<T>(path: string, init?: { method?: string; params?: Record<string, string>; body?: Record<string, unknown> }): Promise<T> {
    const method = init?.method || "GET";
    const url = this.buildUrl(path, init?.params);
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const headers: Record<string, string> = {};
        let body: string | undefined;
        if (init?.body) {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(init.body);
        }

        const res = await fetch(url, { method, headers, body, signal: controller.signal });
        clearTimeout(timer);
        const text = await res.text();

        if (res.ok) {
          if (!text) return {} as T;
          try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
        }

        const envelope = parseEnvelope(text);

        // Token-expired / OAuth errors → never retry, surface a typed error.
        if (isOAuthExpired(envelope)) {
          throw new MetaTokenInvalidError(
            envelope.error?.message || `Meta OAuth error (${res.status})`,
            envelope.error?.code ?? 190,
            envelope.error?.error_subcode,
          );
        }

        const transient = isTransientError(envelope, res.status);
        const apiErr = new MetaApiError(
          envelope.error?.message || `Meta API ${res.status}: ${text.slice(0, 300)}`,
          res.status,
          envelope.error?.code,
          transient,
        );

        if (!transient || attempt === MAX_RETRIES) throw apiErr;
        lastErr = apiErr;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof MetaTokenInvalidError) throw err;
        if (err instanceof MetaApiError && !err.isTransient) throw err;

        const isAbort = err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
        const isNetwork = !(err instanceof MetaApiError);
        if (!isAbort && !isNetwork && !(err instanceof MetaApiError && err.isTransient)) throw err;

        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt === MAX_RETRIES) throw lastErr;
      }

      const delay = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      console.warn(`[Meta] ${method} ${path} attempt ${attempt + 1}/${MAX_RETRIES + 1} retrying in ${delay}ms — ${lastErr?.message || "transient"}`);
      await sleep(delay);
    }

    throw lastErr || new Error("Meta request failed");
  }

  /** Verify access_token is still valid; returns the FB user id/name. */
  async verifyToken(): Promise<{ id: string; name?: string }> {
    return this.request<{ id: string; name?: string }>("/me", { params: { fields: "id,name" } });
  }

  /** List ad accounts the access_token has access to. */
  async listAdAccounts(): Promise<MetaAdAccountInfo[]> {
    interface Resp { data: MetaAdAccountInfo[]; paging?: { next?: string; cursors?: { after?: string } } }
    const all: MetaAdAccountInfo[] = [];
    let nextPath: string | null = "/me/adaccounts";
    let nextParams: Record<string, string> | undefined = { fields: "id,account_id,name,currency", limit: "200" };
    let lastCursor: string | null = null;
    let safety = 0;
    while (nextPath && safety++ < 50) {
      const resp: Resp = await this.request<Resp>(nextPath, nextParams ? { params: nextParams } : undefined);
      if (Array.isArray(resp.data)) all.push(...resp.data);
      const next = resp.paging?.next || null;
      const cursor = resp.paging?.cursors?.after || null;
      // Guard against stuck cursors
      if (next && cursor && cursor === lastCursor) break;
      lastCursor = cursor;
      nextPath = next;
      nextParams = undefined; // next URL already has all params
    }
    return all;
  }

  /** Per-ad daily insights for the configured ad account between [since, until]. */
  async fetchAdDailyInsights(since: string, until: string): Promise<MetaInsightRow[]> {
    if (!this.adAccountId) throw new Error("MetaAPIService: adAccountId required for insights");
    const params: Record<string, string> = {
      fields: "ad_id,ad_name,adset_id,campaign_id,campaign_name,impressions,clicks,spend,cpm,actions,video_play_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions,date_start,date_stop",
      time_range: JSON.stringify({ since, until }),
      level: "ad",
      time_increment: "1",
      limit: "500",
    };

    const all: MetaInsightRow[] = [];
    let nextPath: string | null = `/${this.adAccountId}/insights`;
    let nextParams: Record<string, string> | undefined = params;
    let lastCursor: string | null = null;
    let safety = 0;

    while (nextPath && safety++ < 200) {
      const resp: MetaInsightsResponse = await this.request<MetaInsightsResponse>(nextPath, nextParams ? { params: nextParams } : undefined);
      if (Array.isArray(resp.data)) all.push(...resp.data);
      const next = resp.paging?.next || null;
      const cursor = resp.paging?.cursors?.after || null;
      // Guard against stuck cursors
      if (next && cursor && cursor === lastCursor) break;
      lastCursor = cursor;
      nextPath = next;
      nextParams = undefined;
    }

    return all;
  }

  /** Per-campaign daily aggregate (server-side groupby of /insights at level=campaign). Used by older callers. */
  async fetchCampaignDailyInsights(since: string, until: string): Promise<MetaInsightRow[]> {
    if (!this.adAccountId) throw new Error("MetaAPIService: adAccountId required for insights");
    const params: Record<string, string> = {
      fields: "campaign_id,campaign_name,impressions,clicks,spend,actions,date_start,date_stop",
      time_range: JSON.stringify({ since, until }),
      level: "campaign",
      time_increment: "1",
      limit: "500",
    };
    const all: MetaInsightRow[] = [];
    let nextPath: string | null = `/${this.adAccountId}/insights`;
    let nextParams: Record<string, string> | undefined = params;
    let lastCursor: string | null = null;
    let safety = 0;
    while (nextPath && safety++ < 200) {
      const resp: MetaInsightsResponse = await this.request<MetaInsightsResponse>(nextPath, nextParams ? { params: nextParams } : undefined);
      if (Array.isArray(resp.data)) all.push(...resp.data);
      const next = resp.paging?.next || null;
      const cursor = resp.paging?.cursors?.after || null;
      // Guard against stuck cursors
      if (next && cursor && cursor === lastCursor) break;
      lastCursor = cursor;
      nextPath = next;
      nextParams = undefined;
    }
    return all;
  }

  async fetchAdSets(): Promise<Array<{ id: string; name: string; campaign_id?: string; effective_status?: string; daily_budget?: string }>> {
    if (!this.adAccountId) return [];
    interface Row { id: string; name: string; campaign_id?: string; effective_status?: string; daily_budget?: string }
    interface Resp { data: Row[]; paging?: { next?: string; cursors?: { after?: string } } }
    const all: Row[] = [];
    let nextPath: string | null = `/${this.adAccountId}/adsets`;
    let nextParams: Record<string, string> | undefined = { fields: "id,name,campaign_id,effective_status,daily_budget", limit: "200" };
    let lastCursor: string | null = null;
    let safety = 0;
    while (nextPath && safety++ < 50) {
      const resp: Resp = await this.request<Resp>(nextPath, nextParams ? { params: nextParams } : undefined);
      if (Array.isArray(resp.data)) all.push(...resp.data);
      const next = resp.paging?.next || null;
      const cursor = resp.paging?.cursors?.after || null;
      // Guard against stuck cursors
      if (next && cursor && cursor === lastCursor) break;
      lastCursor = cursor;
      nextPath = next;
      nextParams = undefined;
    }
    return all;
  }

  /**
   * Fetch a single ad creative by id. Used by the creative-metadata backfill
   * for ads that already synced before thumbnail/title/body were captured.
   */
  async fetchAdCreative(creativeId: string): Promise<{ id: string; thumbnail_url?: string; title?: string; body?: string }> {
    return this.request<{ id: string; thumbnail_url?: string; title?: string; body?: string }>(
      `/${creativeId}`,
      { params: { fields: "thumbnail_url,title,body" } },
    );
  }

  async fetchAds(): Promise<Array<{ id: string; name: string; adset_id?: string; campaign_id?: string; effective_status?: string; creative?: { id?: string; thumbnail_url?: string; title?: string; body?: string } }>> {
    if (!this.adAccountId) return [];
    interface Row { id: string; name: string; adset_id?: string; campaign_id?: string; effective_status?: string; creative?: { id?: string; thumbnail_url?: string; title?: string; body?: string } }
    interface Resp { data: Row[]; paging?: { next?: string; cursors?: { after?: string } } }
    const all: Row[] = [];
    let nextPath: string | null = `/${this.adAccountId}/ads`;
    let nextParams: Record<string, string> | undefined = { fields: "id,name,adset_id,campaign_id,effective_status,creative{id,thumbnail_url,title,body}", limit: "200" };
    let lastCursor: string | null = null;
    let safety = 0;
    while (nextPath && safety++ < 50) {
      const resp: Resp = await this.request<Resp>(nextPath, nextParams ? { params: nextParams } : undefined);
      if (Array.isArray(resp.data)) all.push(...resp.data);
      const next = resp.paging?.next || null;
      const cursor = resp.paging?.cursors?.after || null;
      // Guard against stuck cursors
      if (next && cursor && cursor === lastCursor) break;
      lastCursor = cursor;
      nextPath = next;
      nextParams = undefined;
    }
    return all;
  }

  /**
   * Account-wide daily-budget summary, with a 15-minute in-memory cache.
   * Returns last-good cache when a live fetch fails (stale fallback).
   */
  async getAdAccountDailyBudget(): Promise<BudgetCacheEntry> {
    if (!this.adAccountId) throw new Error("adAccountId required");
    const cached = dailyBudgetCache.get(this.adAccountId);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < BUDGET_CACHE_TTL_MS) return cached;

    try {
      const adSets = await this.fetchAdSets();
      const details = adSets
        .filter((a) => a.effective_status === "ACTIVE" && a.daily_budget)
        .map((a) => ({
          adSetId: a.id,
          name: a.name,
          dailyBudgetCents: parseIntField(a.daily_budget),
          effectiveStatus: a.effective_status || "UNKNOWN",
        }));
      const total = details.reduce((s, d) => s + d.dailyBudgetCents, 0);
      const fresh: BudgetCacheEntry = { total, details, fetchedAt: now };
      dailyBudgetCache.set(this.adAccountId, fresh);
      return fresh;
    } catch (err) {
      if (cached) {
        console.warn(`[Meta] Daily-budget fetch failed for ${this.adAccountId}, returning stale cache (${Math.round((now - cached.fetchedAt) / 60000)} min old): ${err instanceof Error ? err.message : err}`);
        return cached;
      }
      throw err;
    }
  }

  async updateAdSetDailyBudget(adSetId: string, dailyBudgetDollars: number): Promise<void> {
    const dailyBudgetCents = Math.round(dailyBudgetDollars * 100);
    await this.request<unknown>(`/${adSetId}`, {
      method: "POST",
      body: { daily_budget: dailyBudgetCents },
    });
    dailyBudgetCache.delete(this.adAccountId);
    console.log(`[Meta] Updated ad set ${adSetId} daily budget to $${dailyBudgetDollars}`);
  }

  async sendCAPIEvents(events: unknown[]): Promise<{ events_received: number; messages: string[] }> {
    if (!this.pixelId) return { events_received: 0, messages: [] };
    if (events.length === 0) return { events_received: 0, messages: [] };
    return this.request<{ events_received: number; messages: string[] }>(`/${this.pixelId}/events`, {
      method: "POST",
      body: { data: events },
    });
  }
}

// ─── Backwards-compatible function exports used by sync-scheduler/budget/reconciliation ───

export async function fetchCampaignInsights(
  config: MetaConfig,
  startDate: string,
  endDate: string,
): Promise<MetaCampaignDailyAggregate[]> {
  const svc = new MetaAPIService(config);
  const rows = await svc.fetchCampaignDailyInsights(startDate, endDate);
  return rows.map((r) => ({
    externalId: r.campaign_id,
    name: r.campaign_name || r.campaign_id,
    date: r.date_start,
    spend: parseNumericField(r.spend),
    impressions: parseIntField(r.impressions),
    clicks: parseIntField(r.clicks),
    conversions: sumConversionActions(r.actions),
    actions: r.actions || [],
  }));
}

export function formatMetaInsight(insight: MetaCampaignDailyAggregate) {
  return {
    externalId: insight.externalId,
    name: insight.name,
    platform: "meta" as const,
    status: "active",
    date: insight.date,
    spend: insight.spend,
    impressions: insight.impressions,
    clicks: insight.clicks,
    conversions: insight.conversions,
    actions: insight.actions,
    currency: insight.currency,
  };
}

export async function updateMetaAdSetBudget(
  config: MetaConfig,
  adSetId: string,
  newDailyBudgetDollars: number,
): Promise<void> {
  const svc = new MetaAPIService(config);
  await svc.updateAdSetDailyBudget(adSetId, newDailyBudgetDollars);
}

interface CAPIEvent {
  event_name: string;
  event_time: number;
  action_source: string;
  user_data: {
    em?: string[];
    ph?: string[];
    client_ip_address?: string;
    client_user_agent?: string;
    fbc?: string;
    fbp?: string;
  };
  custom_data?: { value?: number; currency?: string; content_name?: string };
  event_source_url?: string;
}

export async function sendCAPIEvents(
  config: MetaConfig,
  events: CAPIEvent[],
): Promise<{ eventsReceived: number; messages: string[] }> {
  if (!config.pixelId || events.length === 0) return { eventsReceived: 0, messages: [] };
  try {
    const svc = new MetaAPIService(config);
    const response = await svc.sendCAPIEvents(events);
    console.log(`[Meta CAPI] Sent ${events.length} events, received ${response.events_received}`);
    return { eventsReceived: response.events_received, messages: response.messages || [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Meta CAPI] Event send failed: ${message}`);
    return { eventsReceived: 0, messages: [message] };
  }
}

export function buildCAPILeadEvent(
  hashedEmail: string | null,
  hashedPhone: string | null,
  revenue: number,
  eventTime?: Date,
): CAPIEvent {
  return {
    event_name: "Lead",
    event_time: Math.floor((eventTime || new Date()).getTime() / 1000),
    action_source: "system_generated",
    user_data: {
      ...(hashedEmail ? { em: [hashedEmail] } : {}),
      ...(hashedPhone ? { ph: [hashedPhone] } : {}),
    },
    custom_data: { value: revenue, currency: "USD", content_name: "HVAC Service Lead" },
  };
}
