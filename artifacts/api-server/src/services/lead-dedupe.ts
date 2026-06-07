import { db, leadsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { normalizePhone } from "../lib/phone-utils";

export interface LeadIdentityInput {
  phone?: string | null;
  email?: string | null;
}

export interface NormalizedLeadIdentity {
  phone: string | null;
  email: string | null;
}

export interface ExistingLeadMatch {
  lead: typeof leadsTable.$inferSelect;
  matchedBy: "phone" | "email";
}

type LeadDedupeQueryable = Pick<typeof db, "select" | "insert" | "execute">;

export function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase() ?? "";
  return normalized || null;
}

export function normalizeLeadIdentity(input: LeadIdentityInput): NormalizedLeadIdentity {
  return {
    phone: input.phone ? normalizePhone(input.phone) || null : null,
    email: normalizeEmail(input.email),
  };
}

export function buildLeadIdentityKeys(identity: NormalizedLeadIdentity): string[] {
  const keys = new Set<string>();
  if (identity.email) keys.add(`email:${identity.email}`);
  if (identity.phone) keys.add(`phone:${identity.phone}`);
  return [...keys].sort();
}

export async function findExistingLeadByIdentity(
  queryable: Pick<typeof db, "select">,
  tenantId: number,
  identity: NormalizedLeadIdentity,
): Promise<ExistingLeadMatch | null> {
  if (identity.phone) {
    const [lead] = await queryable
      .select()
      .from(leadsTable)
      .where(and(
        eq(leadsTable.tenantId, tenantId),
        eq(leadsTable.phone, identity.phone),
      ))
      .orderBy(desc(leadsTable.createdAt), desc(leadsTable.id))
      .limit(1);
    if (lead) return { lead, matchedBy: "phone" };
  }

  if (identity.email) {
    const [lead] = await queryable
      .select()
      .from(leadsTable)
      .where(and(
        eq(leadsTable.tenantId, tenantId),
        sql`LOWER(TRIM(COALESCE(${leadsTable.email}, ''))) = ${identity.email}`,
      ))
      .orderBy(desc(leadsTable.createdAt), desc(leadsTable.id))
      .limit(1);
    if (lead) return { lead, matchedBy: "email" };
  }

  return null;
}

export async function lockLeadIdentity(queryable: Pick<typeof db, "execute">, tenantId: number, identity: NormalizedLeadIdentity): Promise<void> {
  const keys = buildLeadIdentityKeys(identity);
  for (const key of keys) {
    await queryable.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lead:${tenantId}:${key}`}, 0))`);
  }
}

export async function createLeadWithDedupe(
  tenantId: number,
  input: LeadIdentityInput,
  createLead: (tx: LeadDedupeQueryable, identity: NormalizedLeadIdentity) => Promise<typeof leadsTable.$inferSelect | undefined>,
): Promise<
  | { deduplicated: false; lead: typeof leadsTable.$inferSelect; matchedBy?: never }
  | { deduplicated: true; lead: typeof leadsTable.$inferSelect; matchedBy: ExistingLeadMatch["matchedBy"] }
> {
  const identity = normalizeLeadIdentity(input);
  const keys = buildLeadIdentityKeys(identity);

  if (keys.length === 0) {
    const lead = await db.transaction(async (tx) => createLead(tx, identity));
    if (!lead) throw new Error("Lead insert returned no row");
    return { deduplicated: false, lead };
  }

  return db.transaction(async (tx) => {
    await lockLeadIdentity(tx, tenantId, identity);
    const existing = await findExistingLeadByIdentity(tx, tenantId, identity);
    if (existing) {
      return { deduplicated: true, lead: existing.lead, matchedBy: existing.matchedBy };
    }

    const lead = await createLead(tx, identity);
    if (!lead) throw new Error("Lead insert returned no row");
    return { deduplicated: false, lead };
  });
}
