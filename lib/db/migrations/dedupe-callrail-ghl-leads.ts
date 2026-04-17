import {
  db,
  pool,
  leadsTable,
  attributionEventsTable,
  callAttemptsTable,
  scheduledFollowupsTable,
  soldEstimatesTable,
  podiumMessagesTable,
  jobsTable,
  tenantsTable,
  leadMergesTable,
} from "../src";
import { and, eq, inArray, sql } from "drizzle-orm";

const WINDOW_MINUTES = 60;

type CandidateRow = {
  canonicalLeadId: number;
  canonicalCreatedAt: Date;
  tenantId: number;
  phone: string;
  externalId: string;
  orphanIds: number[];
  orphanCreatedAts: Date[];
};

type Group = {
  tenantId: number;
  phone: string;
  externalId: string;
  canonicalId: number;
  canonicalCreatedAt: Date;
  duplicateIds: number[];
};

/**
 * Anchor: every surviving CallRail/GHL attribution_event uniquely identifies the
 * canonical lead for one (tenant, external_id). Any *other* lead with the same
 * (tenant, phone) created within +/-WINDOW_MINUTES of the canonical lead and
 * NOT itself referenced by a surviving callrail:/ghl: attribution_event is an
 * orphan whose original attribution_event was removed by the dedupe migration.
 */
async function findDuplicateGroups(): Promise<Group[]> {
  const rows = await db.execute(sql`
    WITH callrail_ghl_events AS (
      SELECT ae.id           AS event_id,
             ae.tenant_id    AS tenant_id,
             ae.external_id  AS external_id,
             ae.created_lead_id AS canonical_lead_id,
             l.created_at    AS canonical_created_at,
             l.phone         AS phone
      FROM ${attributionEventsTable} ae
      JOIN ${leadsTable} l ON l.id = ae.created_lead_id
      WHERE ae.created_lead_id IS NOT NULL
        AND ae.external_id IS NOT NULL
        AND (ae.external_id LIKE 'callrail:%' OR ae.external_id LIKE 'ghl:%')
        AND l.phone IS NOT NULL AND l.phone <> ''
    ),
    referenced_lead_ids AS (
      SELECT DISTINCT created_lead_id AS lead_id
      FROM ${attributionEventsTable}
      WHERE created_lead_id IS NOT NULL
        AND external_id IS NOT NULL
        AND (external_id LIKE 'callrail:%' OR external_id LIKE 'ghl:%')
    ),
    orphans AS (
      SELECT cge.event_id,
             cge.tenant_id,
             cge.external_id,
             cge.canonical_lead_id,
             cge.canonical_created_at,
             cge.phone,
             other.id AS orphan_id,
             other.created_at AS orphan_created_at
      FROM callrail_ghl_events cge
      JOIN ${leadsTable} other
        ON other.tenant_id = cge.tenant_id
       AND other.phone = cge.phone
       AND other.id <> cge.canonical_lead_id
       AND other.created_at >= cge.canonical_created_at - (${WINDOW_MINUTES} || ' minutes')::interval
       AND other.created_at <= cge.canonical_created_at + (${WINDOW_MINUTES} || ' minutes')::interval
      WHERE other.id NOT IN (SELECT lead_id FROM referenced_lead_ids)
    )
    SELECT canonical_lead_id   AS "canonicalLeadId",
           canonical_created_at AS "canonicalCreatedAt",
           tenant_id            AS "tenantId",
           phone,
           external_id          AS "externalId",
           array_agg(orphan_id ORDER BY orphan_id) AS "orphanIds",
           array_agg(orphan_created_at ORDER BY orphan_id) AS "orphanCreatedAts"
    FROM orphans
    GROUP BY canonical_lead_id, canonical_created_at, tenant_id, phone, external_id
  `);

  const data = (rows as unknown as { rows: CandidateRow[] }).rows
    ?? (rows as unknown as CandidateRow[]);

  // An orphan could in principle match more than one canonical lead's window.
  // Bind each orphan to its closest canonical (smallest |Δ time|, then lowest canonical id).
  const orphanAssignment = new Map<number, { canonicalId: number; deltaMs: number; tenantId: number; phone: string; externalId: string; canonicalCreatedAt: Date }>();
  for (const row of data) {
    const ids = row.orphanIds.map(Number);
    const createdAts = row.orphanCreatedAts.map(d => new Date(d));
    const canonicalCreatedAt = new Date(row.canonicalCreatedAt);
    for (let i = 0; i < ids.length; i++) {
      const orphanId = ids[i];
      const deltaMs = Math.abs(createdAts[i].getTime() - canonicalCreatedAt.getTime());
      const existing = orphanAssignment.get(orphanId);
      if (!existing || deltaMs < existing.deltaMs
          || (deltaMs === existing.deltaMs && row.canonicalLeadId < existing.canonicalId)) {
        orphanAssignment.set(orphanId, {
          canonicalId: row.canonicalLeadId,
          deltaMs,
          tenantId: row.tenantId,
          phone: row.phone,
          externalId: row.externalId,
          canonicalCreatedAt,
        });
      }
    }
  }

  const groupsByCanonical = new Map<number, Group>();
  for (const [orphanId, assign] of orphanAssignment) {
    const existing = groupsByCanonical.get(assign.canonicalId);
    if (existing) {
      existing.duplicateIds.push(orphanId);
    } else {
      groupsByCanonical.set(assign.canonicalId, {
        tenantId: assign.tenantId,
        phone: assign.phone,
        externalId: assign.externalId,
        canonicalId: assign.canonicalId,
        canonicalCreatedAt: assign.canonicalCreatedAt,
        duplicateIds: [orphanId],
      });
    }
  }
  for (const g of groupsByCanonical.values()) g.duplicateIds.sort((a, b) => a - b);
  return [...groupsByCanonical.values()].sort((a, b) =>
    a.tenantId - b.tenantId || a.canonicalId - b.canonicalId,
  );
}

const SCRIPT_SOURCE = "dedupe-callrail-ghl-leads";

async function mergeGroup(group: Group, runId: string): Promise<void> {
  const { canonicalId, duplicateIds } = group;
  if (duplicateIds.length === 0) return;

  await db.transaction(async (tx) => {
    // Preserve assignment / status fields from the oldest duplicate where the
    // canonical lacks them (best-effort: never overwrite existing canonical data).
    const [canonical] = await tx.select().from(leadsTable)
      .where(eq(leadsTable.id, canonicalId)).limit(1);
    const dupes = await tx.select().from(leadsTable)
      .where(inArray(leadsTable.id, duplicateIds))
      .orderBy(leadsTable.id);

    if (canonical) {
      const patch: Partial<typeof leadsTable.$inferInsert> = {};
      const preserveIfEmpty = <K extends keyof typeof canonical>(key: K) => {
        const cur = canonical[key];
        if (cur !== null && cur !== undefined && cur !== "") return;
        for (const d of dupes) {
          const v = d[key];
          if (v !== null && v !== undefined && v !== "") {
            (patch as Record<string, unknown>)[key as string] = v;
            return;
          }
        }
      };
      preserveIfEmpty("assignedTo");
      preserveIfEmpty("assignedCsrId");
      preserveIfEmpty("bookedByCsrId");
      preserveIfEmpty("matchedGclid");
      preserveIfEmpty("email");
      preserveIfEmpty("notes");
      preserveIfEmpty("address");
      preserveIfEmpty("city");
      preserveIfEmpty("state");
      preserveIfEmpty("zip");
      preserveIfEmpty("appointmentDate");
      preserveIfEmpty("appointmentTime");

      // assignedAt: take earliest non-default value across canonical+dupes
      const allAssignedAt = [canonical, ...dupes]
        .map(l => l.assignedAt)
        .filter((d): d is Date => !!d);
      if (allAssignedAt.length > 0) {
        const earliest = allAssignedAt.reduce((a, b) => (a < b ? a : b));
        if (!canonical.assignedAt || earliest < canonical.assignedAt) {
          patch.assignedAt = earliest;
        }
      }

      if (Object.keys(patch).length > 0) {
        patch.updatedAt = new Date();
        await tx.update(leadsTable).set(patch).where(eq(leadsTable.id, canonicalId));
      }
    }

    await tx.update(callAttemptsTable)
      .set({ leadId: canonicalId })
      .where(inArray(callAttemptsTable.leadId, duplicateIds));

    await tx.update(scheduledFollowupsTable)
      .set({ leadId: canonicalId })
      .where(inArray(scheduledFollowupsTable.leadId, duplicateIds));

    await tx.update(soldEstimatesTable)
      .set({ leadId: canonicalId })
      .where(inArray(soldEstimatesTable.leadId, duplicateIds));

    await tx.update(podiumMessagesTable)
      .set({ leadId: canonicalId })
      .where(inArray(podiumMessagesTable.leadId, duplicateIds));

    await tx.update(jobsTable)
      .set({ leadId: canonicalId })
      .where(inArray(jobsTable.leadId, duplicateIds));

    await tx.update(attributionEventsTable)
      .set({ createdLeadId: canonicalId })
      .where(and(
        eq(attributionEventsTable.tenantId, group.tenantId),
        inArray(attributionEventsTable.createdLeadId, duplicateIds),
      ));

    // Audit trail: record each merge before hard-deleting the duplicate row.
    // `duplicate_lead_id` is unique, so re-runs (or accidental retries) will
    // surface as a constraint violation rather than silently double-write.
    await tx.insert(leadMergesTable).values(
      duplicateIds.map((duplicateLeadId) => ({
        tenantId: group.tenantId,
        duplicateLeadId,
        canonicalLeadId: canonicalId,
        source: SCRIPT_SOURCE,
        runId,
      })),
    );

    await tx.delete(leadsTable).where(inArray(leadsTable.id, duplicateIds));
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");

  if (!dryRun && !apply) {
    console.log("Usage: tsx dedupe-callrail-ghl-leads.ts [--dry-run | --apply]");
    process.exit(1);
  }

  console.log(`[Dedupe Leads] ${dryRun ? "DRY RUN" : "APPLY"} - scanning for orphan CallRail/GHL leads (window=${WINDOW_MINUTES}m)`);

  const groups = await findDuplicateGroups();

  const tenants = await db.select({ id: tenantsTable.id, name: tenantsTable.name }).from(tenantsTable);
  const tenantNames = new Map(tenants.map(t => [t.id, t.name]));

  const perTenant = new Map<number, { groups: number; duplicates: number }>();
  for (const g of groups) {
    const cur = perTenant.get(g.tenantId) ?? { groups: 0, duplicates: 0 };
    cur.groups += 1;
    cur.duplicates += g.duplicateIds.length;
    perTenant.set(g.tenantId, cur);
  }

  console.log("\n=== Summary report (per tenant) ===");
  console.log("tenant_id | tenant_name | canonical_leads_with_orphans | orphan_leads_to_merge");
  console.log("----------+-------------+------------------------------+----------------------");
  let totalGroups = 0;
  let totalDupes = 0;
  for (const [tenantId, stats] of [...perTenant.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`${tenantId} | ${tenantNames.get(tenantId) ?? "?"} | ${stats.groups} | ${stats.duplicates}`);
    totalGroups += stats.groups;
    totalDupes += stats.duplicates;
  }
  console.log("----------+-------------+------------------------------+----------------------");
  console.log(`TOTAL: ${totalGroups} canonical leads, ${totalDupes} orphan leads to merge`);

  if (dryRun) {
    console.log("\n=== Sample groups (up to 20) ===");
    for (const g of groups.slice(0, 20)) {
      console.log(`  tenant=${g.tenantId} phone=${g.phone} ext=${g.externalId} keep=${g.canonicalId}@${g.canonicalCreatedAt.toISOString()} merge=[${g.duplicateIds.join(",")}]`);
    }
    console.log("\n[Dedupe Leads] DRY RUN complete. Re-run with --apply to perform the merge.");
    return;
  }

  const runId = `${SCRIPT_SOURCE}:${new Date().toISOString()}`;
  console.log(`\n[Dedupe Leads] Applying merges (run_id=${runId})...`);
  let merged = 0;
  for (const g of groups) {
    try {
      await mergeGroup(g, runId);
      merged += g.duplicateIds.length;
    } catch (err) {
      console.error(`[Dedupe Leads] Failed to merge group tenant=${g.tenantId} ext=${g.externalId} keep=${g.canonicalId}:`, err);
    }
  }
  console.log(`[Dedupe Leads] Done. Merged ${merged} orphan leads across ${groups.length} canonical leads (run_id=${runId}).`);
}

main()
  .then(() => pool.end().then(() => process.exit(0)))
  .catch((err) => {
    console.error("[Dedupe Leads] Failed:", err);
    pool.end().then(() => process.exit(1));
  });
