import { withRetry } from "./rate-limiter";

const META_GRAPH_BASE = "https://graph.facebook.com/v21.0";

interface MetaConfig {
  accessToken: string;
  adAccountId: string;
  pixelId?: string;
}

interface MetaCampaignInsight {
  campaign_id: string;
  campaign_name: string;
  date_start: string;
  date_stop: string;
  impressions: string;
  clicks: string;
  spend: string;
  actions?: Array<{ action_type: string; value: string }>;
}

interface MetaInsightsResponse {
  data: MetaCampaignInsight[];
  paging?: { next?: string };
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
  custom_data?: {
    value?: number;
    currency?: string;
    content_name?: string;
  };
  event_source_url?: string;
}

async function metaFetch<T>(accessToken: string, path: string, options: RequestInit = {}): Promise<T> {
  return withRetry(async () => {
    const url = `${META_GRAPH_BASE}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers as Record<string, string> || {}),
    };

    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Meta API error (${response.status}): ${text}`);
    }
    return response.json() as Promise<T>;
  }, { label: `Meta ${path}`, maxRetries: 3 });
}

export async function fetchCampaignInsights(
  config: MetaConfig,
  startDate: string,
  endDate: string,
): Promise<MetaCampaignInsight[]> {
  const accountId = config.adAccountId.startsWith("act_") ? config.adAccountId : `act_${config.adAccountId}`;
  const allInsights: MetaCampaignInsight[] = [];

  const params = new URLSearchParams({
    fields: "campaign_id,campaign_name,impressions,clicks,spend,actions",
    time_range: JSON.stringify({ since: startDate, until: endDate }),
    level: "campaign",
    time_increment: "1",
    limit: "500",
  });

  let nextUrl: string | null = `/${accountId}/insights?${params.toString()}`;

  while (nextUrl) {
    const response: MetaInsightsResponse = await metaFetch<MetaInsightsResponse>(config.accessToken, nextUrl);
    allInsights.push(...response.data);
    nextUrl = response.paging?.next ? response.paging.next.replace(META_GRAPH_BASE, "") : null;
  }

  return allInsights;
}

export function formatMetaInsight(insight: MetaCampaignInsight) {
  const conversions = insight.actions?.find((a) => a.action_type === "offsite_conversion.fb_pixel_lead")?.value;
  return {
    externalId: insight.campaign_id,
    name: insight.campaign_name,
    platform: "meta" as const,
    status: "active",
    date: insight.date_start,
    spend: parseFloat(insight.spend) || 0,
    impressions: parseInt(insight.impressions) || 0,
    clicks: parseInt(insight.clicks) || 0,
    conversions: conversions ? parseInt(conversions) : 0,
  };
}

export async function sendCAPIEvents(
  config: MetaConfig,
  events: CAPIEvent[],
): Promise<{ eventsReceived: number; messages: string[] }> {
  if (!config.pixelId || events.length === 0) {
    return { eventsReceived: 0, messages: [] };
  }

  try {
    const response = await metaFetch<{ events_received: number; messages: string[] }>(
      config.accessToken,
      `/${config.pixelId}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: events }),
      },
    );

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
    custom_data: {
      value: revenue,
      currency: "USD",
      content_name: "HVAC Service Lead",
    },
  };
}
