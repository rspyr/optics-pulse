import { db, leadSourceAliasesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

interface CacheEntry {
  map: Map<string, string>;
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();
const TTL_MS = 60_000;

async function loadAliasMap(tenantId: number): Promise<Map<string, string>> {
  const rows = await db.select({
    alias: leadSourceAliasesTable.alias,
    canonicalName: leadSourceAliasesTable.canonicalName,
  }).from(leadSourceAliasesTable)
    .where(eq(leadSourceAliasesTable.tenantId, tenantId));

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.alias.toLowerCase().trim(), row.canonicalName);
  }
  return map;
}

async function getAliasMap(tenantId: number): Promise<Map<string, string>> {
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.map;
  }
  const map = await loadAliasMap(tenantId);
  cache.set(tenantId, { map, expiresAt: Date.now() + TTL_MS });
  return map;
}

export async function normalizeSource(tenantId: number, rawSource: string): Promise<string> {
  if (!rawSource) return rawSource;
  const map = await getAliasMap(tenantId);
  const key = rawSource.toLowerCase().trim();
  return map.get(key) ?? rawSource;
}

export function invalidateSourceCache(tenantId: number): void {
  cache.delete(tenantId);
}

export const DEFAULT_SOURCE_ALIASES: { canonicalName: string; aliases: string[] }[] = [
  { canonicalName: "Meta", aliases: ["meta", "fb", "facebook", "ig", "instagram", "meta_ads", "facebook_ads", "fb_ads"] },
  { canonicalName: "Google", aliases: ["google", "google_g", "search", "gp", "sem", "ppc", "google_ads", "adwords", "google_search"] },
  { canonicalName: "LSA", aliases: ["lsa", "local_service_ads", "local_services", "google_lsa"] },
  { canonicalName: "GMB", aliases: ["gmb", "google_my_business", "google_business", "gbp", "google_business_profile"] },
  { canonicalName: "YouTube", aliases: ["youtube", "yt", "youtube_ads"] },
  { canonicalName: "TikTok", aliases: ["tiktok", "tt", "tik_tok", "tiktok_ads"] },
  { canonicalName: "Direct Mail", aliases: ["direct_mail", "dm", "mailer", "postcard", "mail"] },
  { canonicalName: "Email", aliases: ["email", "email_campaign", "email_marketing"] },
  { canonicalName: "Referral", aliases: ["referral", "ref", "referred", "word_of_mouth"] },
];
