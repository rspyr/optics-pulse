import { db, subdomainFunnelRulesTable, funnelTypesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

interface SubdomainFunnelMatch {
  funnelTypeId: number;
  funnelName: string;
}

interface CacheEntry {
  map: Map<string, SubdomainFunnelMatch>;
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();
const TTL_MS = 60_000;

async function loadRuleMap(tenantId: number): Promise<Map<string, SubdomainFunnelMatch>> {
  const rows = await db
    .select({
      subdomain: subdomainFunnelRulesTable.subdomain,
      funnelTypeId: subdomainFunnelRulesTable.funnelTypeId,
      funnelName: funnelTypesTable.name,
    })
    .from(subdomainFunnelRulesTable)
    .innerJoin(funnelTypesTable, eq(subdomainFunnelRulesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(subdomainFunnelRulesTable.tenantId, tenantId));

  const map = new Map<string, SubdomainFunnelMatch>();
  for (const row of rows) {
    map.set(row.subdomain.toLowerCase().trim(), {
      funnelTypeId: row.funnelTypeId,
      funnelName: row.funnelName,
    });
  }
  return map;
}

async function getRuleMap(tenantId: number): Promise<Map<string, SubdomainFunnelMatch>> {
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.map;
  }
  const map = await loadRuleMap(tenantId);
  cache.set(tenantId, { map, expiresAt: Date.now() + TTL_MS });
  return map;
}

/**
 * Extract the normalized subdomain from a page URL. Returns `null` if the URL
 * is missing, malformed, points to an apex domain (e.g. `example.com`), or
 * the only subdomain label is `www` (treated as apex per the task spec).
 *
 * Examples:
 *   "https://protect.advantageheatingllc.com/quote" → "protect"
 *   "https://www.protect.example.com"              → "protect"
 *   "https://www.example.com"                      → null
 *   "https://example.com"                          → null
 *   "https://a.b.example.com"                      → "a.b"
 */
export function extractSubdomain(pageUrl: string | null | undefined): string | null {
  if (!pageUrl) return null;
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase().trim();
  } catch {
    return null;
  }
  if (!host) return null;
  if (host.startsWith("www.")) host = host.slice(4);
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 3) return null;
  return parts.slice(0, parts.length - 2).join(".");
}

export async function resolveSubdomainFunnel(
  tenantId: number,
  pageUrl: string | null | undefined,
): Promise<SubdomainFunnelMatch | null> {
  const sub = extractSubdomain(pageUrl);
  if (!sub) return null;
  const map = await getRuleMap(tenantId);
  return map.get(sub) || null;
}

export function invalidateSubdomainFunnelCache(tenantId: number): void {
  cache.delete(tenantId);
}
