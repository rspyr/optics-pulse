import crypto from "crypto";
import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, leadsTable } from "@workspace/db";

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits;
}

export function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export function hashPhone(phone: string): string {
  return hashValue(normalizePhone(phone));
}

export function hashEmail(email: string): string {
  return hashValue(email);
}

/**
 * SQL predicate matching a phone column against `input` after normalization.
 *
 * Stored phones are kept in canonical (digits-only, leading "1" stripped)
 * form via on-write normalization plus the leads.phone backfill migration,
 * so this is a plain equality against the bare column. Keeping the column
 * unwrapped lets the planner use the b-tree index on `leads.phone`.
 */
export function phoneMatchesSql(column: PgColumn, input: string): SQL {
  const normalized = normalizePhone(input);
  return eq(column, normalized);
}

/**
 * Look up leads by phone within a tenant, normalizing both the input and the
 * stored column so callers don't need to know the storage format.
 *
 * Returns an empty array when `phone` normalizes to an empty string.
 */
export async function findLeadsByPhone(
  tenantId: number,
  phone: string | null | undefined,
  limit = 10,
): Promise<Array<typeof leadsTable.$inferSelect>> {
  const normalized = normalizePhone(phone || "");
  if (!normalized) return [];
  return db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.tenantId, tenantId), phoneMatchesSql(leadsTable.phone, normalized)))
    .limit(limit);
}

/**
 * Convenience: first lead matching `phone` within tenant, or null.
 */
export async function findLeadByPhone(
  tenantId: number,
  phone: string | null | undefined,
): Promise<typeof leadsTable.$inferSelect | null> {
  const [lead] = await findLeadsByPhone(tenantId, phone, 1);
  return lead ?? null;
}
