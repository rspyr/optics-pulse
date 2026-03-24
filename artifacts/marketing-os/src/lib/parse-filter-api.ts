const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export interface ParsedFilterResult {
  source?: string;
  leadType?: string;
  assignedTo?: string;
  status?: string;
  disposition?: string;
  dateRange?: { startDate: string; endDate: string };
}

export interface ParseFilterResponse {
  filters: ParsedFilterResult;
  empty: boolean;
}

export async function parseLeadFilter(
  query: string,
  tenantId?: number,
): Promise<ParseFilterResponse> {
  const url = new URL(`${API_BASE}/api/leads/parse-filter`, window.location.origin);
  if (tenantId) url.searchParams.set("tenantId", String(tenantId));

  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || "Failed to parse filter query");
  }

  return resp.json() as Promise<ParseFilterResponse>;
}
