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

interface STContact {
  type: string;
  value: string;
  memo?: string;
}

interface STCustomer {
  id: number;
  name: string;
  contacts?: STContact[];
}

interface STLocation {
  id: number;
  address?: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
  };
}

interface STJobType {
  id: number;
  name: string;
}

interface STBusinessUnit {
  id: number;
  name: string;
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
  customer?: STCustomer;
  location?: STLocation;
  type?: STJobType;
  businessUnit?: STBusinessUnit;
  customFields?: Array<{
    typeId: number;
    name: string;
    value: string;
  }>;
}

interface STJobsResponse {
  data: STJob[];
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
}

interface STCustomersResponse {
  data: STCustomer[];
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

async function stFetch<T>(config: STAuthConfig, path: string, options: RequestInit = {}, apiModule = "jpm"): Promise<T> {
  await rateLimiter.acquire();

  return withRetry(async () => {
    const token = await getAccessToken(config);
    const url = `${ST_API_BASE}/${apiModule}/v2/tenant/${config.tenantId}${path}`;
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

export async function fetchCustomersByIds(
  config: STAuthConfig,
  customerIds: number[],
): Promise<Map<number, STCustomer>> {
  const customerMap = new Map<number, STCustomer>();
  if (customerIds.length === 0) return customerMap;

  const uniqueIds = [...new Set(customerIds)];
  const batchSize = 50;

  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);
    const idsParam = batch.join(",");

    try {
      const response = await stFetch<STCustomersResponse>(
        config,
        `/customers?ids=${idsParam}&pageSize=${batchSize}`,
        {},
        "crm",
      );

      for (const customer of response.data) {
        customerMap.set(customer.id, customer);
      }
    } catch (err) {
      console.warn(`[ServiceTitan] Failed to fetch customer batch: ${(err as Error).message}`);
    }
  }

  return customerMap;
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

  const customerIds = allJobs.map((j) => j.customerId).filter(Boolean);
  if (customerIds.length > 0) {
    try {
      const customerMap = await fetchCustomersByIds(config, customerIds);
      for (const job of allJobs) {
        if (job.customerId && customerMap.has(job.customerId)) {
          job.customer = customerMap.get(job.customerId);
        }
      }
      console.log(`[ServiceTitan] Enriched ${customerMap.size} customers with contact info`);
    } catch (err) {
      console.warn(`[ServiceTitan] Customer enrichment failed, using basic names: ${(err as Error).message}`);
    }
  }

  return allJobs;
}

function extractPhone(customer?: STCustomer): string | null {
  if (!customer?.contacts) return null;
  const phoneContact = customer.contacts.find(
    (c) => c.type === "MobilePhone" || c.type === "Phone",
  ) || customer.contacts.find(
    (c) => c.type?.toLowerCase().includes("phone"),
  );
  return phoneContact?.value || null;
}

function extractEmail(customer?: STCustomer): string | null {
  if (!customer?.contacts) return null;
  const emailContact = customer.contacts.find(
    (c) => c.type === "Email",
  ) || customer.contacts.find(
    (c) => c.type?.toLowerCase().includes("email"),
  );
  return emailContact?.value || null;
}

function extractJobTypeName(stJob: STJob): string {
  if (stJob.type?.name) return stJob.type.name;

  const summary = (stJob.summary || "").trim();
  const firstLine = summary.split("\n")[0]?.trim();
  if (firstLine && firstLine.length < 80) return firstLine;

  return "Service";
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
  const phone = extractPhone(stJob.customer);
  const email = extractEmail(stJob.customer);

  return {
    stJobId: String(stJob.id),
    stCustomerId: String(stJob.customerId),
    customerName: stJob.customer?.name || `Customer ${stJob.customerId}`,
    customerPhone: phone,
    customerEmail: email,
    serviceAddress: address
      ? `${address.street}, ${address.city}, ${address.state} ${address.zip}`
      : null,
    jobType: stJob.summary || "Service",
    jobTypeName: extractJobTypeName(stJob),
    businessUnit: stJob.businessUnit?.name || null,
    revenue: stJob.total || 0,
    status: stJob.jobStatus.toLowerCase() === "completed" ? "completed" as const : "pending" as const,
    completedAt: stJob.completedOn ? new Date(stJob.completedOn) : null,
  };
}

export function clearTokenCache() {
  tokenCache = new Map();
}
