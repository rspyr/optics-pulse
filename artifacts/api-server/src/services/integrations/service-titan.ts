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

export interface STJob {
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

interface STLocationsResponse {
  data: STLocation[];
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

export async function fetchCustomerContactsById(
  config: STAuthConfig,
  customerId: number,
): Promise<STContact[]> {
  try {
    await rateLimiter.acquire();
    const token = await getAccessToken(config);
    const url = `${ST_API_BASE}/crm/v2/tenant/${config.tenantId}/customers/${customerId}/contacts`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(config.appKey ? { "ST-App-Key": config.appKey } : {}),
    };

    const response = await fetch(url, { headers });
    if (!response.ok) {
      return [];
    }
    const data = await response.json() as { data: STContact[] };
    return data.data || [];
  } catch {
    return [];
  }
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

export async function fetchLocationsByIds(
  config: STAuthConfig,
  locationIds: number[],
): Promise<Map<number, STLocation>> {
  const locationMap = new Map<number, STLocation>();
  if (locationIds.length === 0) return locationMap;

  const uniqueIds = [...new Set(locationIds)];
  const batchSize = 50;

  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);
    const idsParam = batch.join(",");

    try {
      const response = await stFetch<STLocationsResponse>(
        config,
        `/locations?ids=${idsParam}&pageSize=${batchSize}`,
        {},
        "crm",
      );

      for (const location of response.data) {
        locationMap.set(location.id, location);
      }
    } catch (err) {
      console.warn(`[ServiceTitan] Failed to fetch location batch: ${(err as Error).message}`);
    }
  }

  return locationMap;
}

export function formatLocationAddress(address: { street: string; city: string; state: string; zip: string }): string {
  const parts = [address.street, address.city, `${address.state} ${address.zip}`].filter(Boolean);
  return parts.join(", ");
}

export async function fetchCompletedJobs(
  config: STAuthConfig,
  modifiedAfter?: string,
  onBatch?: (jobs: STJob[]) => Promise<void>,
  modifiedBefore?: string,
): Promise<STJob[]> {
  const PAGES_PER_BATCH = 5;
  let page = 1;
  const pageSize = 100;
  let hasMore = true;
  let batchJobs: STJob[] = [];
  let totalFetched = 0;
  let totalRevenue = 0;
  const collectedJobs: STJob[] = [];

  async function enrichBatch(jobs: STJob[]): Promise<STJob[]> {
    if (jobs.length === 0) return jobs;
    const revenueJobs = jobs.filter((j) => j.total > 0);
    const customerIds = revenueJobs.map((j) => j.customerId).filter(Boolean);
    const locationIds = revenueJobs.map((j) => j.locationId).filter(Boolean);

    const [customerMap, locationMap] = await Promise.all([
      customerIds.length > 0
        ? fetchCustomersByIds(config, customerIds).catch((err) => {
            console.warn(`[ServiceTitan] Customer enrichment failed: ${(err as Error).message}`);
            return new Map<number, STCustomer>();
          })
        : Promise.resolve(new Map<number, STCustomer>()),
      locationIds.length > 0
        ? fetchLocationsByIds(config, locationIds).catch((err) => {
            console.warn(`[ServiceTitan] Location enrichment failed: ${(err as Error).message}`);
            return new Map<number, STLocation>();
          })
        : Promise.resolve(new Map<number, STLocation>()),
    ]);

    for (const job of jobs) {
      if (job.customerId && customerMap.has(job.customerId)) {
        job.customer = customerMap.get(job.customerId);
      }
      if (job.locationId && locationMap.has(job.locationId)) {
        job.location = locationMap.get(job.locationId);
      }
    }
    return jobs;
  }

  async function processBatch(jobs: STJob[]) {
    const enriched = await enrichBatch(jobs);
    totalFetched += enriched.length;
    totalRevenue += enriched.filter((j) => j.total > 0).length;

    if (onBatch) {
      await onBatch(enriched);
    } else {
      collectedJobs.push(...enriched);
    }
  }

  while (hasMore) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      jobStatus: "Completed",
    });
    if (modifiedAfter) {
      params.set("modifiedOnOrAfter", modifiedAfter);
    }
    if (modifiedBefore) {
      params.set("modifiedBefore", modifiedBefore);
    }

    const response = await stFetch<STJobsResponse>(config, `/jobs?${params.toString()}`);
    batchJobs.push(...response.data);
    hasMore = response.hasMore;

    if (page % PAGES_PER_BATCH === 0 || !hasMore) {
      console.log(`[ServiceTitan] Fetched page ${page}, processing batch of ${batchJobs.length} jobs`);
      await processBatch(batchJobs);
      batchJobs = [];
    }
    page++;

    if (page > 50) break;
  }

  if (batchJobs.length > 0) {
    await processBatch(batchJobs);
  }

  console.log(`[ServiceTitan] ${totalFetched} total jobs, ${totalRevenue} with revenue`);
  return collectedJobs;
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

export interface STInvoiceItem {
  id: number;
  description: string;
  quantity: string;
  price: string;
  total: string;
  type: string;
  skuName: string;
}

export interface STInvoice {
  id: number;
  total: string;
  balance: string;
  invoiceDate: string;
  paidOn: string | null;
  job: { id: number; number: string; type: string } | null;
  items: STInvoiceItem[];
  active: boolean;
}

interface STInvoicesResponse {
  data: STInvoice[];
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
}

export async function fetchInvoices(
  config: STAuthConfig,
  modifiedAfter?: string,
  processBatch?: (invoices: STInvoice[]) => Promise<void>,
): Promise<STInvoice[]> {
  let page = 1;
  const pageSize = 50;
  let hasMore = true;
  const allInvoices: STInvoice[] = [];
  let batchInvoices: STInvoice[] = [];

  while (hasMore) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });
    if (modifiedAfter) {
      params.set("modifiedOnOrAfter", modifiedAfter);
    }

    const response = await stFetch<STInvoicesResponse>(
      config,
      `/invoices?${params.toString()}`,
      {},
      "accounting",
    );

    const jobInvoices = response.data.filter((inv) => inv.job && inv.active !== false);
    batchInvoices.push(...jobInvoices);
    hasMore = response.hasMore;

    if (batchInvoices.length >= 100 || !hasMore) {
      if (processBatch) {
        await processBatch(batchInvoices);
      } else {
        allInvoices.push(...batchInvoices);
      }
      batchInvoices = [];
    }

    page++;
    if (page > 100) break;
  }

  if (batchInvoices.length > 0) {
    if (processBatch) {
      await processBatch(batchInvoices);
    } else {
      allInvoices.push(...batchInvoices);
    }
  }

  return allInvoices;
}

export function parseInvoiceData(invoice: STInvoice) {
  const total = parseFloat(invoice.total) || 0;
  const balance = parseFloat(invoice.balance) || 0;

  let rebateAmount = 0;
  for (const item of invoice.items || []) {
    const itemTotal = parseFloat(item.total) || 0;
    if (itemTotal < 0) {
      rebateAmount += Math.abs(itemTotal);
    }
  }

  const paidAmount = total - balance;

  return {
    stInvoiceId: String(invoice.id),
    invoiceTotal: total,
    invoiceRebateAmount: rebateAmount,
    invoicePaidAmount: paidAmount > 0 ? paidAmount : 0,
    invoiceBalance: balance,
    invoiceDate: invoice.invoiceDate ? new Date(invoice.invoiceDate) : null,
    invoicePaidOn: invoice.paidOn ? new Date(invoice.paidOn) : null,
    stJobId: invoice.job ? String(invoice.job.id) : null,
  };
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
    stLocationId: stJob.locationId ? String(stJob.locationId) : null,
    customerName: stJob.customer?.name || `Customer ${stJob.customerId}`,
    customerPhone: phone,
    customerEmail: email,
    serviceAddress: address ? formatLocationAddress(address) : null,
    jobType: stJob.summary || "Service",
    jobTypeName: extractJobTypeName(stJob),
    businessUnit: stJob.businessUnit?.name || null,
    revenue: stJob.total || 0,
    status: stJob.jobStatus.toLowerCase() === "completed" ? "completed" as const : "pending" as const,
    completedAt: stJob.completedOn ? new Date(stJob.completedOn) : null,
  };
}

export interface STEstimateItem {
  id: number;
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  type: string;
  skuName?: string;
}

export interface STEstimate {
  id: number;
  jobId: number;
  name: string;
  status: { name: string; value: number };
  summary: string;
  soldBy: number | null;
  soldOn: string | null;
  subtotal: number;
  total: number;
  items: STEstimateItem[];
  modifiedOn: string;
  active: boolean;
}

interface STEstimatesResponse {
  data: STEstimate[];
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
}

interface STEmployee {
  id: number;
  name: string;
  email?: string;
}

export async function fetchSoldEstimates(
  config: STAuthConfig,
  modifiedAfter?: string,
  processBatch?: (estimates: STEstimate[]) => Promise<void>,
): Promise<STEstimate[]> {
  let page = 1;
  const pageSize = 50;
  let hasMore = true;
  const allEstimates: STEstimate[] = [];
  let batchEstimates: STEstimate[] = [];

  while (hasMore) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      status: "Sold",
    });
    if (modifiedAfter) {
      params.set("modifiedOnOrAfter", modifiedAfter);
    }

    const response = await stFetch<STEstimatesResponse>(
      config,
      `/estimates?${params.toString()}`,
      {},
      "sales",
    );

    const activeEstimates = response.data.filter((est) => est.active !== false);
    batchEstimates.push(...activeEstimates);
    hasMore = response.hasMore;

    if (batchEstimates.length >= 50 || !hasMore) {
      if (processBatch) {
        await processBatch(batchEstimates);
      } else {
        allEstimates.push(...batchEstimates);
      }
      batchEstimates = [];
    }

    page++;
    if (page > 100) break;
  }

  if (batchEstimates.length > 0) {
    if (processBatch) {
      await processBatch(batchEstimates);
    } else {
      allEstimates.push(...batchEstimates);
    }
  }

  return allEstimates;
}

const employeeCache = new Map<string, Map<number, string>>();

export async function resolveEmployeeName(
  config: STAuthConfig,
  employeeId: number,
): Promise<string | null> {
  const tenantKey = config.tenantId;
  let cache = employeeCache.get(tenantKey);
  if (!cache) {
    cache = new Map();
    employeeCache.set(tenantKey, cache);
  }

  if (cache.has(employeeId)) {
    return cache.get(employeeId) || null;
  }

  try {
    const employee = await stFetch<STEmployee>(
      config,
      `/employees/${employeeId}`,
      {},
      "settings",
    );
    const name = employee.name || null;
    cache.set(employeeId, name || "");
    return name;
  } catch {
    cache.set(employeeId, "");
    return null;
  }
}

export function clearEmployeeCache() {
  employeeCache.clear();
}

export function parseEstimateData(estimate: STEstimate) {
  const subtotal = estimate.subtotal || 0;

  let rebateAmount = 0;
  for (const item of estimate.items || []) {
    const itemTotal = item.total || 0;
    if (itemTotal < 0) {
      rebateAmount += Math.abs(itemTotal);
    }
  }

  const totalAmount = subtotal + rebateAmount;

  return {
    stEstimateId: String(estimate.id),
    stJobId: estimate.jobId ? String(estimate.jobId) : null,
    subtotal,
    rebateAmount,
    totalAmount,
    soldOn: estimate.soldOn ? new Date(estimate.soldOn) : null,
    soldByEmployeeId: estimate.soldBy,
  };
}

export function clearTokenCache() {
  tokenCache = new Map();
}
