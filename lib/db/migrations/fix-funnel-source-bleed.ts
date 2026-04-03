import { db, leadsTable, funnelTypesTable, tenantsTable } from "../src";
import { eq, and, inArray } from "drizzle-orm";

async function fixFunnelSourceBleed() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`[Migration] Fixing leads where funnel names were saved as source... ${dryRun ? "(DRY RUN)" : ""}`);

  const tenants = await db.select({ id: tenantsTable.id, name: tenantsTable.name }).from(tenantsTable);

  let totalAffected = 0;
  let totalUpdated = 0;

  for (const tenant of tenants) {
    const funnels = await db.select({ name: funnelTypesTable.name })
      .from(funnelTypesTable)
      .where(eq(funnelTypesTable.tenantId, tenant.id));

    const funnelNames = [...new Set(funnels.map(f => f.name))];
    if (funnelNames.length === 0) continue;

    const affectedLeads = await db.select({ id: leadsTable.id, source: leadsTable.source })
      .from(leadsTable)
      .where(and(
        eq(leadsTable.tenantId, tenant.id),
        inArray(leadsTable.source, funnelNames)
      ));

    if (affectedLeads.length === 0) continue;

    totalAffected += affectedLeads.length;
    console.log(`[Migration] Tenant "${tenant.name}" (id=${tenant.id}): ${affectedLeads.length} leads with funnel names as source (funnels: ${funnelNames.join(", ")})`);

    if (dryRun) {
      for (const lead of affectedLeads.slice(0, 5)) {
        console.log(`  - Lead ${lead.id}: source="${lead.source}"`);
      }
      if (affectedLeads.length > 5) console.log(`  ... and ${affectedLeads.length - 5} more`);
      continue;
    }

    const affectedIds = affectedLeads.map(l => l.id);
    const batchSize = 500;

    for (let i = 0; i < affectedIds.length; i += batchSize) {
      const batch = affectedIds.slice(i, i + batchSize);
      await db.update(leadsTable)
        .set({ source: "Unknown", updatedAt: new Date() })
        .where(inArray(leadsTable.id, batch));
      totalUpdated += batch.length;
    }
  }

  if (dryRun) {
    console.log(`[Migration] DRY RUN complete. Would update ${totalAffected} leads across all tenants.`);
  } else {
    console.log(`[Migration] Done. Updated ${totalUpdated} leads from funnel-name sources to "Unknown".`);
  }
}

fixFunnelSourceBleed()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("[Migration] Failed:", err);
    process.exit(1);
  });
