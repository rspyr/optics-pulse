import { db, funnelAliasesTable, funnelTypesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

interface FunnelMatch {
  funnelTypeId: number;
  funnelName: string;
}

interface CacheEntry {
  map: Map<string, FunnelMatch>;
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();
const TTL_MS = 60_000;

async function loadAliasMap(tenantId: number): Promise<Map<string, FunnelMatch>> {
  const rows = await db
    .select({
      alias: funnelAliasesTable.alias,
      funnelTypeId: funnelAliasesTable.funnelTypeId,
      funnelName: funnelTypesTable.name,
    })
    .from(funnelAliasesTable)
    .innerJoin(funnelTypesTable, eq(funnelAliasesTable.funnelTypeId, funnelTypesTable.id))
    .where(eq(funnelAliasesTable.tenantId, tenantId));

  const map = new Map<string, FunnelMatch>();
  for (const row of rows) {
    map.set(row.alias.toLowerCase().trim(), {
      funnelTypeId: row.funnelTypeId,
      funnelName: row.funnelName,
    });
  }
  return map;
}

async function getAliasMap(tenantId: number): Promise<Map<string, FunnelMatch>> {
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.map;
  }
  const map = await loadAliasMap(tenantId);
  cache.set(tenantId, { map, expiresAt: Date.now() + TTL_MS });
  return map;
}

export async function normalizeFunnel(
  tenantId: number,
  rawValue: string,
): Promise<FunnelMatch | null> {
  const map = await getAliasMap(tenantId);
  const key = (rawValue || "").toLowerCase().trim();
  if (!key) return null;
  return map.get(key) || null;
}

export function invalidateFunnelCache(tenantId: number): void {
  cache.delete(tenantId);
}

export const DEFAULT_FUNNEL_ALIASES: { funnelSlug: string; aliases: string[] }[] = [
  {
    funnelSlug: "install",
    aliases: [
      "install", "installation", "hvac install", "hvac installation",
      "new system", "new unit", "system replacement", "replacement",
      "furnace install", "ac install", "air conditioner install",
      "new equipment", "equipment replacement", "full system",
    ],
  },
  {
    funnelSlug: "repair",
    aliases: [
      "repair", "fix", "hvac repair", "ac repair", "heating repair",
      "furnace repair", "air conditioner repair", "broken",
      "not working", "not cooling", "not heating", "emergency repair",
    ],
  },
  {
    funnelSlug: "maintenance",
    aliases: [
      "maintenance", "tune up", "tune-up", "tuneup", "service",
      "hvac maintenance", "preventive maintenance", "seasonal",
      "inspection", "check up", "check-up", "annual service",
    ],
  },
  {
    funnelSlug: "commercial",
    aliases: [
      "commercial", "commercial hvac", "business", "commercial repair",
      "commercial install", "commercial maintenance", "office",
    ],
  },
  {
    funnelSlug: "emergency",
    aliases: [
      "emergency", "urgent", "same day", "same-day", "asap",
      "emergency repair", "emergency service", "after hours",
    ],
  },
];
