import crypto from "crypto";
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

/**
 * Hashes an internal ServiceTitan job id into the privacy-preserving
 * `st_job_id_hash` value stored on jobs. The raw st_job_id is purged at 24h
 * (PII), but this hash is retained, so it is the only stable key that links a
 * purged historical job row back to its ServiceTitan record. The date-range
 * reconciliation (Task #821) re-fetches completed jobs and matches them to
 * purged rows by hashing each fetched job id with this function. The sync
 * scheduler computes the same hash when it first ingests a job, so this MUST
 * stay identical to the hashing used there or the match silently yields nothing.
 */
export function hashStJobId(stJobId: string): string {
  return crypto.createHash("sha256").update(stJobId).digest("hex");
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
    // Enrich EVERY completed job, not just those carrying revenue at sync time.
    // Most jobs are $0 when first synced (they are invoiced/closed out later),
    // so gating enrichment on total>0 left ~70% of jobs with no customer name
    // or service address — which blanked the revenue-attribution panel and
    // prevented lead matching (Task #825).
    const customerIds = jobs.map((j) => j.customerId).filter(Boolean);
    const locationIds = jobs.map((j) => j.locationId).filter(Boolean);

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

    // Safety cap: 500 pages × 100 = 50,000 jobs per single call.
    // Initial backfills with wide windows can exceed the previous 5,000-job
    // cap silently — the backfill route already chunks the timeline into
    // 90-day windows so this only fires on pathological tenants. If we hit
    // it, log loudly so operators see an incomplete page walk in the
    // workflow logs instead of finding it later via missing-data symptoms.
    if (page > 500) {
      console.warn(
        `[ServiceTitan] fetchCompletedJobs hit 500-page safety cap (modifiedAfter=${modifiedAfter ?? "none"}, modifiedBefore=${modifiedBefore ?? "none"}); ${totalFetched} jobs fetched so far, more remain. Narrow the window via the backfill chunker.`,
      );
      break;
    }
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

// ServiceTitan address shape as returned embedded on invoices (customerAddress
// / locationAddress). Mirrors STLocation.address but declared locally because
// the invoice endpoint inlines it rather than nesting under `location`.
interface STInvoiceAddress {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface STInvoice {
  id: number;
  total: string;
  balance: string;
  invoiceDate: string;
  paidOn: string | null;
  job: { id: number; number: string; type: string } | null;
  // The Accounting invoice object carries the customer + service location
  // inline (name + address). We capture these so customer name / service
  // address can be populated straight from the invoice when separate job
  // enrichment is absent (Task #819).
  customer?: { id: number; name: string } | null;
  customerAddress?: STInvoiceAddress | null;
  location?: { id: number; name: string } | null;
  locationAddress?: STInvoiceAddress | null;
  items: STInvoiceItem[];
  active: boolean;
}

/**
 * Formats a ServiceTitan inline invoice address into the same single-line
 * string shape used for job-enriched addresses, tolerating partially-populated
 * objects (the invoice endpoint can omit individual parts). Returns null when
 * nothing usable is present.
 */
function formatInvoiceAddress(address: STInvoiceAddress | null | undefined): string | null {
  if (!address) return null;
  const stateZip = [address.state, address.zip].filter(Boolean).join(" ").trim();
  const parts = [address.street, address.city, stateZip].filter((p) => p && p.trim());
  return parts.length > 0 ? parts.join(", ") : null;
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
  onTotalCount?: (totalCount: number) => void,
): Promise<STInvoice[]> {
  let page = 1;
  const pageSize = 50;
  let hasMore = true;
  const allInvoices: STInvoice[] = [];
  let batchInvoices: STInvoice[] = [];
  let reportedTotal = false;

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

    // Surface the upstream total-count once (first page) so callers can show a
    // percent-complete bar. ServiceTitan returns the same totalCount on every
    // page; we only fire the callback once to avoid redundant writes.
    if (!reportedTotal && onTotalCount && typeof response.totalCount === "number") {
      reportedTotal = true;
      onTotalCount(response.totalCount);
    }

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
    // Safety cap: 1000 pages × 50 = 50,000 invoices per single call. The
    // incremental sync only walks recent (post-watermark) pages so this never
    // fires there; a full re-sync (recompute-revenue) can walk the whole
    // history, so log loudly if we truncate instead of silently leaving old
    // rows on the pre-fix revenue logic.
    if (page > 1000) {
      console.warn(
        `[ServiceTitan] fetchInvoices hit 1000-page safety cap (modifiedAfter=${modifiedAfter ?? "none"}); more invoices remain unfetched — full re-sync is incomplete.`,
      );
      break;
    }
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

/**
 * Fetches specific invoices by their internal ServiceTitan ids. Used by the
 * one-time backfill (Task #819) to resolve the human-readable job number
 * (invoice.job.number) for jobs that still carry a retained internal invoice id
 * but no job number. Batches into the `ids=` filter (same pattern as
 * fetchCustomersByIds) and tolerates partial failures by skipping a failed
 * batch rather than aborting the whole backfill.
 */
export async function fetchInvoicesByIds(
  config: STAuthConfig,
  invoiceIds: number[],
): Promise<STInvoice[]> {
  const out: STInvoice[] = [];
  if (invoiceIds.length === 0) return out;

  const uniqueIds = [...new Set(invoiceIds)];
  const batchSize = 50;

  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);
    const idsParam = batch.join(",");
    try {
      const response = await stFetch<STInvoicesResponse>(
        config,
        `/invoices?ids=${idsParam}&pageSize=${batchSize}`,
        {},
        "accounting",
      );
      out.push(...response.data);
    } catch (err) {
      console.warn(`[ServiceTitan] Failed to fetch invoice batch by ids: ${(err as Error).message}`);
    }
  }

  return out;
}

// ServiceTitan subtracts certain rebates (e.g. Energy Trust of Oregon "ETO"
// and ODEE) from the estimate/invoice total even though the company still
// collects that money — so those rebate line items are real revenue and must
// be added back. Genuine discounts/coupons are also negative line items but
// are NOT real revenue, so only line items whose label matches a known rebate
// program are added back.
//
// The list of rebate programs is configurable per tenant (DB-backed, editable
// from the integrations admin UI). These are the seeded defaults used when a
// tenant has not customized its own list — see `getTenantRebatePatterns` in
// sync-scheduler.ts for how the per-tenant list is resolved.
export const DEFAULT_REBATE_LABELS: string[] = ["ETO", "Energy Trust", "ODEE"];

/**
 * Compiles a plain, staff-entered rebate program label into a case-insensitive,
 * word-boundary regex. Staff enter human-readable names (e.g. "Energy Trust"),
 * not regex — special characters are escaped and internal whitespace is allowed
 * to vary (matching "Energy Trust", "Energy  Trust" and "EnergyTrust"). Returns
 * null for blank labels.
 */
export function compileRebatePattern(label: string): RegExp | null {
  const trimmed = (label || "").trim();
  if (!trimmed) return null;
  const escaped = trimmed
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s*");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

/** Compiles a list of rebate labels into regexes, dropping any blank entries. */
export function compileRebatePatterns(labels: string[]): RegExp[] {
  return labels
    .map(compileRebatePattern)
    .filter((p): p is RegExp => p !== null);
}

// Compiled defaults, exported for callers/tests that need the seeded behavior
// without resolving a tenant's custom configuration.
export const REBATE_LABEL_PATTERNS: RegExp[] = compileRebatePatterns(DEFAULT_REBATE_LABELS);

export interface RebateLineItem {
  label: string;
  amount: number;
}

/**
 * Returns true when a line item label identifies a rebate (real revenue ST
 * removed from the total) rather than a genuine discount. Matches the combined
 * labels (description, SKU name, etc.) against the provided rebate patterns,
 * defaulting to the seeded defaults when none are supplied.
 */
export function isRebateLineItem(
  labels: Array<string | null | undefined>,
  patterns: RegExp[] = REBATE_LABEL_PATTERNS,
): boolean {
  const text = labels.filter(Boolean).join(" ").trim();
  if (!text) return false;
  return patterns.some((p) => p.test(text));
}

export function parseInvoiceData(invoice: STInvoice, patterns: RegExp[] = REBATE_LABEL_PATTERNS) {
  const total = parseFloat(invoice.total) || 0;
  const balance = parseFloat(invoice.balance) || 0;

  let rebateAmount = 0;
  const rebateBreakdown: RebateLineItem[] = [];
  for (const item of invoice.items || []) {
    const itemTotal = parseFloat(item.total) || 0;
    if (itemTotal < 0 && isRebateLineItem([item.description, item.skuName], patterns)) {
      const amount = Math.abs(itemTotal);
      rebateAmount += amount;
      rebateBreakdown.push({ label: item.skuName || item.description || "Rebate", amount });
    }
  }

  const paidAmount = total - balance;

  return {
    stInvoiceId: String(invoice.id),
    invoiceTotal: total,
    invoiceRebateAmount: rebateAmount,
    invoiceRebateBreakdown: rebateBreakdown,
    invoicePaidAmount: paidAmount > 0 ? paidAmount : 0,
    invoiceBalance: balance,
    invoiceDate: invoice.invoiceDate ? new Date(invoice.invoiceDate) : null,
    invoicePaidOn: invoice.paidOn ? new Date(invoice.paidOn) : null,
    stJobId: invoice.job ? String(invoice.job.id) : null,
    // ServiceTitan has no invoice number — the job number IS the invoice number.
    stJobNumber: invoice.job?.number ? String(invoice.job.number) : null,
    // Customer name + service address straight from the invoice, used as a
    // fallback when job-based enrichment didn't populate them (Task #819).
    customerName: invoice.customer?.name?.trim() || null,
    serviceAddress:
      formatInvoiceAddress(invoice.locationAddress) ??
      formatInvoiceAddress(invoice.customerAddress),
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
    // Human-readable job number = portal-findable job/invoice number (Task #819).
    stJobNumber: stJob.number ? String(stJob.number) : null,
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
  followUpOn?: string | null;
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
  onTotalCount?: (totalCount: number) => void,
  options?: { status?: string | null },
): Promise<STEstimate[]> {
  let page = 1;
  const pageSize = 50;
  let hasMore = true;
  const allEstimates: STEstimate[] = [];
  let batchEstimates: STEstimate[] = [];
  let reportedTotal = false;

  while (hasMore) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });
    const status = options?.status === undefined ? "Sold" : options.status;
    if (status) params.set("status", status);
    if (modifiedAfter) {
      params.set("modifiedOnOrAfter", modifiedAfter);
    }

    const response = await stFetch<STEstimatesResponse>(
      config,
      `/estimates?${params.toString()}`,
      {},
      "sales",
    );

    // Surface the upstream total-count once (first page) so callers can show a
    // percent-complete bar. See fetchInvoices for rationale.
    if (!reportedTotal && onTotalCount && typeof response.totalCount === "number") {
      reportedTotal = true;
      onTotalCount(response.totalCount);
    }

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
    // Safety cap: 1000 pages × 50 = 50,000 estimates per single call. The
    // incremental sync only walks recent (post-watermark) pages so this never
    // fires there; a full re-sync (recompute-revenue) can walk the whole
    // history, so log loudly if we truncate instead of silently leaving old
    // rows on the pre-fix revenue logic.
    if (page > 1000) {
      console.warn(
        `[ServiceTitan] fetchSoldEstimates hit 1000-page safety cap (modifiedAfter=${modifiedAfter ?? "none"}); more estimates remain unfetched — full re-sync is incomplete.`,
      );
      break;
    }
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

export function parseEstimateData(estimate: STEstimate, patterns: RegExp[] = REBATE_LABEL_PATTERNS) {
  // `subtotal` is the ServiceTitan-reported total, which already has rebate
  // line items subtracted out. We add back only the rebate line items (ETO,
  // ODEE, etc.) — genuine discounts stay subtracted — to get true revenue.
  const subtotal = estimate.subtotal || 0;

  let rebateAmount = 0;
  const rebateBreakdown: RebateLineItem[] = [];
  for (const item of estimate.items || []) {
    const itemTotal = item.total || 0;
    if (itemTotal < 0 && isRebateLineItem([item.description, item.skuName], patterns)) {
      const amount = Math.abs(itemTotal);
      rebateAmount += amount;
      rebateBreakdown.push({ label: item.skuName || item.description || "Rebate", amount });
    }
  }

  const totalAmount = subtotal + rebateAmount;

  return {
    stEstimateId: String(estimate.id),
    stJobId: estimate.jobId ? String(estimate.jobId) : null,
    estimateName: estimate.name || null,
    estimateStatus: estimate.status?.name || null,
    summary: estimate.summary || null,
    followUpOn: estimate.followUpOn ? new Date(estimate.followUpOn) : null,
    subtotal,
    rebateAmount,
    totalAmount,
    rebateBreakdown,
    soldOn: estimate.soldOn ? new Date(estimate.soldOn) : null,
    soldByEmployeeId: estimate.soldBy,
  };
}

export function clearTokenCache() {
  tokenCache = new Map();
}
