import { withRetry } from "./rate-limiter";

const GHL_BASE = "https://rest.gohighlevel.com/v1";

interface GHLConfig {
  apiKey: string;
  locationId?: string;
}

interface GHLContact {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  source?: string;
  tags?: string[];
  customField?: Record<string, string>;
}

async function ghlFetch<T>(config: GHLConfig, path: string, options: RequestInit = {}): Promise<T> {
  return withRetry(async () => {
    const url = `${GHL_BASE}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> || {}),
    };

    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GHL API error (${response.status}): ${text}`);
    }
    return response.json() as Promise<T>;
  }, { label: `GHL ${path}`, maxRetries: 3 });
}

export async function fetchGHLContacts(
  config: GHLConfig,
  limit = 20,
): Promise<GHLContact[]> {
  const response = await ghlFetch<{ contacts: GHLContact[] }>(
    config,
    `/contacts/?limit=${limit}${config.locationId ? `&locationId=${config.locationId}` : ""}`,
  );
  return response.contacts || [];
}

export async function getGHLContact(config: GHLConfig, contactId: string): Promise<GHLContact | null> {
  try {
    const response = await ghlFetch<{ contact: GHLContact }>(config, `/contacts/${contactId}`);
    return response.contact || null;
  } catch {
    return null;
  }
}

export function parseGHLWebhookPayload(body: Record<string, unknown>): {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  source: string;
  gclid: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  utmMedium: string | null;
  landingPage: string | null;
} {
  const customFields = (body.customData || body.custom_fields || {}) as Record<string, string>;

  return {
    firstName: (body.first_name || body.firstName || "Unknown") as string,
    lastName: (body.last_name || body.lastName || "") as string,
    email: (body.email || null) as string | null,
    phone: (body.phone || null) as string | null,
    source: "ghl",
    gclid: customFields._mos_gclid || customFields.gclid || null,
    utmSource: customFields._mos_utmSource || customFields.utm_source || (body.utm_source as string) || null,
    utmCampaign: customFields._mos_utmCampaign || customFields.utm_campaign || null,
    utmMedium: customFields._mos_utmMedium || customFields.utm_medium || null,
    landingPage: customFields._mos_landingPage || (body.landing_page as string) || null,
  };
}
