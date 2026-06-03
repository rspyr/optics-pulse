import { db, routeFunnelRulesTable, funnelTypesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

interface RouteFunnelMatch {
  funnelTypeId: number;
  funnelName: string;
}

interface CacheEntry {
  map: Map<string, RouteFunnelMatch>;
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();
const TTL_MS = 60_000;

async function loadRuleMap(tenantId: number): Promise<Map<string, RouteFunnelMatch>> {
  const rows = await db
    .select({
      routePath: routeFunnelRulesTable.routePath,
      funnelTypeId: routeFunnelRulesTable.funnelTypeId,
      funnelName: funnelTypesTable.name,
    })
    .from(routeFunnelRulesTable)
    .innerJoin(funnelTypesTable, eq(routeFunnelRulesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(routeFunnelRulesTable.tenantId, tenantId));

  const map = new Map<string, RouteFunnelMatch>();
  for (const row of rows) {
    map.set(normalizeRoutePath(row.routePath) ?? row.routePath.toLowerCase().trim(), {
      funnelTypeId: row.funnelTypeId,
      funnelName: row.funnelName,
    });
  }
  return map;
}

async function getRuleMap(tenantId: number): Promise<Map<string, RouteFunnelMatch>> {
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.map;
  }
  const map = await loadRuleMap(tenantId);
  cache.set(tenantId, { map, expiresAt: Date.now() + TTL_MS });
  return map;
}

/**
 * Normalize a route/page path for exact matching. Accepts either a full URL
 * (https://host/path?query#hash) or a bare path (`/Summer-Relief/`). Returns:
 *   - lowercased pathname
 *   - query string and hash stripped
 *   - trailing slash removed (except for the root "/")
 *   - leading slash enforced
 * Returns `null` when no meaningful path can be extracted.
 *
 * Examples:
 *   "https://promotions.example.com/Summer-Relief?utm=x" → "/summer-relief"
 *   "/summer-relief/"                                     → "/summer-relief"
 *   "https://example.com/"                                → "/"
 *   "summer-relief"                                       → "/summer-relief"
 */
export function normalizeRoutePath(input: string | null | undefined): string | null {
  if (!input) return null;
  let raw = input.trim();
  if (!raw) return null;

  let pathname: string;
  try {
    // Absolute URL.
    pathname = new URL(raw).pathname;
  } catch {
    // Bare path (or path?query#hash). Strip query/hash manually.
    raw = raw.split("#")[0].split("?")[0];
    pathname = raw.startsWith("/") ? raw : `/${raw}`;
  }

  pathname = pathname.toLowerCase().trim();
  if (!pathname) return null;
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  // Collapse a trailing slash to the canonical form, but keep root "/".
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  if (!pathname) pathname = "/";
  return pathname;
}

export async function resolveRouteFunnel(
  tenantId: number,
  pageUrl: string | null | undefined,
): Promise<RouteFunnelMatch | null> {
  const path = normalizeRoutePath(pageUrl);
  if (!path) return null;
  const map = await getRuleMap(tenantId);
  return map.get(path) || null;
}

export function invalidateRouteFunnelCache(tenantId: number): void {
  cache.delete(tenantId);
}
