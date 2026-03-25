/**
 * Development Database: Wipe all ServiceTitan data and pause ST sync.
 *
 * Run from the api-server directory:
 *   cd artifacts/api-server && pnpm exec tsx ../../scripts/wipe-servicetitan-data-dev.ts
 */
import { db, tenantsTable, jobsTable, integrationSyncLogsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { decryptConfig, encryptConfig } from "./src/lib/encryption";

const ST_CREDENTIAL_KEYS = [
  "serviceTitanClientId",
  "serviceTitanClientSecret",
  "serviceTitanAppKey",
  "serviceTitanTenantId",
];

async function wipeAll() {
  console.log("[Dev Wipe] Starting ServiceTitan data wipe...\n");

  const jobResult = await db.delete(jobsTable);
  console.log("[Dev Wipe] Deleted all jobs");

  await db
    .delete(integrationSyncLogsTable)
    .where(eq(integrationSyncLogsTable.integration, "service_titan"));
  console.log("[Dev Wipe] Deleted all ServiceTitan sync logs");

  await db
    .update(tenantsTable)
    .set({ stSyncPaused: true, serviceTitanId: null, updatedAt: new Date() });
  console.log("[Dev Wipe] Set st_sync_paused=true and cleared service_titan_id for all tenants");

  const tenants = await db.select().from(tenantsTable);
  let credentialsCleared = 0;
  for (const tenant of tenants) {
    if (!tenant.apiConfig || typeof tenant.apiConfig !== "string") continue;
    try {
      const config = decryptConfig(tenant.apiConfig) as Record<string, unknown>;
      let changed = false;
      for (const key of ST_CREDENTIAL_KEYS) {
        if (key in config) {
          delete config[key];
          changed = true;
        }
      }
      if (changed) {
        await db
          .update(tenantsTable)
          .set({ apiConfig: encryptConfig(config), updatedAt: new Date() })
          .where(eq(tenantsTable.id, tenant.id));
        credentialsCleared++;
        console.log(
          `[Dev Wipe] Cleared ST credentials for tenant ${tenant.id} (${tenant.name})`,
        );
      }
    } catch (err) {
      console.error(`[Dev Wipe] Failed tenant ${tenant.id}:`, err);
    }
  }

  console.log(`\n[Dev Wipe] Complete:`);
  console.log(`  - All jobs deleted`);
  console.log(`  - ST sync logs deleted`);
  console.log(`  - All tenants paused (st_sync_paused=true)`);
  console.log(`  - service_titan_id cleared on all tenants`);
  console.log(`  - ST credentials cleared from ${credentialsCleared} tenant(s)`);
  process.exit(0);
}

wipeAll().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
