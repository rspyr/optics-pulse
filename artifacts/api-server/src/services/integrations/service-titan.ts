import { TokenBucketRateLimiter, withRetry } from "./rate-limiter";

const ST_API_BASE = "https://api.servicetitan.io";
const ST_AUTH_BASE = "https://auth.servicetitan.io/connect/token";

const rateLimiter = new TokenBucketRateLimiter(10, 5, 1000);

interface STAuthConfig {
  clientId: string;
  clientSecret: string;
  appKey?: string;
  tenantId: string;
}

interface STJob {
  id: number;
  number: string;
  customerId: number;
  locationId: number;
  jobStatus: string;
  summary: string;
  total: number;
  completedOn: string | null;
  customer?: {
    name: string;
  };
  location?: {
    address: {
      street: string;
      city: string;
      state: string;
      zip: string;
    };
  };
}

interface STJobsResponse {
  data: STJob[];
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
}

let tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();

async function getAccessToken(config: STAuthConfig): Promise<string> {
  const cacheKey = `${config.clientId}:${config.tenantId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await fetch(ST_AUTH_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ServiceTitan auth failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });

  return data.access_token;
}

async function stFetch<T>(config: STAuthConfig, path: string, options: RequestInit = {}): Promise<T> {
  await rateLimiter.acquire();

  return withRetry(async () => {
    const token = await getAccessToken(config);
    const url = `${ST_API_BASE}/jpm/v2/tenant/${config.tenantId}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(config.appKey ? { "ST-App-Key": config.appKey } : {}),
    };

    const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers as Record<string, string> || {}) } });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ServiceTitan API error (${response.status}): ${text}`);
    }
    return response.json() as Promise<T>;
  }, { label: `ServiceTitan ${path}`, maxRetries: 3 });
}

export async function fetchCompletedJobs(
  config: STAuthConfig,
  modifiedAfter?: string,
): Promise<STJob[]> {
  const allJobs: STJob[] = [];
  let page = 1;
  const pageSize = 100;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      jobStatus: "Completed",
    });
    if (modifiedAfter) {
      params.set("modifiedOnOrAfter", modifiedAfter);
    }

    const response = await stFetch<STJobsResponse>(config, `/jobs?${params.toString()}`);
    allJobs.push(...response.data);
    hasMore = response.hasMore;
    page++;

    if (page > 50) break;
  }

  return allJobs;
}

export async function patchJobCustomField(
  config: STAuthConfig,
  jobId: number,
  fieldName: string,
  fieldValue: string,
): Promise<void> {
  await stFetch<unknown>(config, `/jobs/${jobId}`, {
    method: "PATCH",
    body: JSON.stringify({
      customFields: [{ name: fieldName, value: fieldValue }],
    }),
  });
}

export function formatSTJobForSync(stJob: STJob) {
  const address = stJob.location?.address;
  return {
    stJobId: String(stJob.id),
    customerName: stJob.customer?.name || `Customer ${stJob.customerId}`,
    serviceAddress: address ? `${address.street}, ${address.city}` : null,
    jobType: stJob.summary || "Service",
    revenue: stJob.total || 0,
    status: stJob.jobStatus.toLowerCase() === "completed" ? "completed" as const : "pending" as const,
    completedAt: stJob.completedOn ? new Date(stJob.completedOn) : null,
  };
}

export function clearTokenCache() {
  tokenCache = new Map();
}
