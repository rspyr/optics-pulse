import { withRetry } from "./rate-limiter";
import type { OciPayload } from "../reconciliation";

const GOOGLE_ADS_API_VERSION = "v17";
const GOOGLE_ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

interface GoogleAdsConfig {
  developerToken: string;
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  customerId: string;
  loginCustomerId?: string;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getValidAccessToken(config: GoogleAdsConfig): Promise<string> {
  if (!config.refreshToken || !config.clientId || !config.clientSecret) {
    return config.accessToken;
  }

  const cacheKey = `${config.customerId}:${config.refreshToken.slice(-8)}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Google Ads] Token refresh failed (${response.status}): ${text}`);
      return config.accessToken;
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    const expiresAt = Date.now() + data.expires_in * 1000;
    tokenCache.set(cacheKey, { token: data.access_token, expiresAt });
    console.log(`[Google Ads] Access token refreshed for customer ${config.customerId}`);
    return data.access_token;
  } catch (err) {
    console.error(`[Google Ads] Token refresh error:`, err instanceof Error ? err.message : err);
    return config.accessToken;
  }
}

interface CampaignPerformanceRow {
  campaign: {
    id: string;
    name: string;
    status: string;
  };
  metrics: {
    impressions: string;
    clicks: string;
    costMicros: string;
    conversions: number;
    averageCpc: string;
  };
  segments: {
    date: string;
  };
}

interface GoogleAdsSearchResponse {
  results: CampaignPerformanceRow[];
  nextPageToken?: string;
}

async function googleAdsFetch<T>(config: GoogleAdsConfig, path: string, options: RequestInit = {}): Promise<T> {
  return withRetry(async () => {
    const accessToken = await getValidAccessToken(config);
    const url = `${GOOGLE_ADS_BASE}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": config.developerToken,
      "Content-Type": "application/json",
    };
    if (config.loginCustomerId) {
      headers["login-customer-id"] = config.loginCustomerId.replace(/-/g, "");
    }

    const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers as Record<string, string> || {}) } });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google Ads API error (${response.status}): ${text}`);
    }
    return response.json() as Promise<T>;
  }, { label: `Google Ads ${path}`, maxRetries: 3 });
}

export async function fetchCampaignPerformance(
  config: GoogleAdsConfig,
  startDate: string,
  endDate: string,
): Promise<CampaignPerformanceRow[]> {
  const customerId = config.customerId.replace(/-/g, "");
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.average_cpc,
      segments.date
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status != 'REMOVED'
    ORDER BY segments.date DESC
  `;

  const allResults: CampaignPerformanceRow[] = [];
  let pageToken: string | undefined;

  do {
    const body: Record<string, unknown> = { query, pageSize: 1000 };
    if (pageToken) body.pageToken = pageToken;

    const response = await googleAdsFetch<GoogleAdsSearchResponse>(
      config,
      `/customers/${customerId}/googleAds:search`,
      { method: "POST", body: JSON.stringify(body) },
    );

    if (response.results) allResults.push(...response.results);
    pageToken = response.nextPageToken;
  } while (pageToken);

  return allResults;
}

export function formatCampaignRow(row: CampaignPerformanceRow) {
  return {
    externalId: row.campaign.id,
    name: row.campaign.name,
    platform: "google_ads" as const,
    status: row.campaign.status.toLowerCase() === "enabled" ? "active" : "paused",
    date: row.segments.date,
    spend: Number(row.metrics.costMicros) / 1_000_000,
    impressions: Number(row.metrics.impressions),
    clicks: Number(row.metrics.clicks),
    conversions: Math.round(row.metrics.conversions || 0),
  };
}

export async function updateGoogleAdsCampaignBudget(
  config: GoogleAdsConfig,
  campaignId: string,
  newDailyBudgetDollars: number,
): Promise<void> {
  const customerId = config.customerId.replace(/-/g, "");
  const budgetMicros = Math.round(newDailyBudgetDollars * 1_000_000);

  const query = `SELECT campaign_budget.resource_name FROM campaign WHERE campaign.id = '${campaignId}'`;
  const searchResponse = await googleAdsFetch<GoogleAdsSearchResponse>(
    config,
    `/customers/${customerId}/googleAds:search`,
    { method: "POST", body: JSON.stringify({ query, pageSize: 1 }) },
  );

  if (!searchResponse.results || searchResponse.results.length === 0) {
    throw new Error(`Campaign ${campaignId} not found in Google Ads`);
  }

  const budgetResource = (searchResponse.results[0] as unknown as Record<string, Record<string, string>>).campaignBudget?.resourceName;
  if (!budgetResource) {
    throw new Error(`No budget resource found for campaign ${campaignId}`);
  }

  await googleAdsFetch(
    config,
    `/customers/${customerId}/campaignBudgets:mutate`,
    {
      method: "POST",
      body: JSON.stringify({
        operations: [{
          update: {
            resourceName: budgetResource,
            amountMicros: String(budgetMicros),
          },
          updateMask: "amount_micros",
        }],
      }),
    },
  );

  console.log(`[Google Ads] Updated budget for campaign ${campaignId} to $${newDailyBudgetDollars}/day`);
}

export async function uploadEnhancedConversions(
  config: GoogleAdsConfig,
  conversions: Array<{
    conversionAction: string;
    conversionDateTime: string;
    conversionValue: number;
    currencyCode: string;
    hashedEmail?: string;
    hashedPhone?: string;
  }>,
): Promise<{ successCount: number; errorCount: number; errors: string[] }> {
  if (conversions.length === 0) return { successCount: 0, errorCount: 0, errors: [] };
  const customerId = config.customerId.replace(/-/g, "");

  const payload = conversions.map(c => ({
    conversionAction: c.conversionAction,
    conversionDateTime: c.conversionDateTime,
    conversionValue: c.conversionValue,
    currencyCode: c.currencyCode,
    userIdentifiers: [
      ...(c.hashedEmail ? [{ hashedEmail: c.hashedEmail }] : []),
      ...(c.hashedPhone ? [{ hashedPhoneNumber: c.hashedPhone }] : []),
    ],
  }));

  try {
    await googleAdsFetch(
      config,
      `/customers/${customerId}:uploadClickConversions`,
      {
        method: "POST",
        body: JSON.stringify({ conversions: payload, partialFailure: true }),
      },
    );
    console.log(`[Google Ads Enhanced] Uploaded ${conversions.length} enhanced conversions`);
    return { successCount: conversions.length, errorCount: 0, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Google Ads Enhanced] Upload failed: ${message}`);
    return { successCount: 0, errorCount: conversions.length, errors: [message] };
  }
}

export async function uploadOfflineConversions(
  config: GoogleAdsConfig,
  payloads: OciPayload[],
  conversionActionResourceName: string,
): Promise<{ successCount: number; errorCount: number; errors: string[] }> {
  if (payloads.length === 0) return { successCount: 0, errorCount: 0, errors: [] };

  const customerId = config.customerId.replace(/-/g, "");
  const conversions = payloads.map((p) => ({
    gclid: p.gclid,
    conversionAction: conversionActionResourceName,
    conversionDateTime: p.conversionDateTime,
    conversionValue: p.conversionValue,
    currencyCode: p.currencyCode,
  }));

  try {
    await googleAdsFetch(
      config,
      `/customers/${customerId}:uploadClickConversions`,
      {
        method: "POST",
        body: JSON.stringify({
          conversions,
          partialFailure: true,
        }),
      },
    );

    console.log(`[Google Ads OCI] Uploaded ${payloads.length} conversions for customer ${customerId}`);
    return { successCount: payloads.length, errorCount: 0, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Google Ads OCI] Upload failed: ${message}`);
    return { successCount: 0, errorCount: payloads.length, errors: [message] };
  }
}
