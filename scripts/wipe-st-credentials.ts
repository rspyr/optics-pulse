/**
 * Wipe ServiceTitan credentials from all tenants' encrypted api_config.
 *
 * Run from the api-server directory:
 *   cd artifacts/api-server && pnpm exec tsx ../../scripts/wipe-st-credentials.ts
 */
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptConfig, encryptConfig } from "../artifacts/api-server/src/lib/encryption";

const ST_CREDENTIAL_KEYS = [
  "serviceTitanClientId",
  "serviceTitanClientSecret",
  "serviceTitanAppKey",
  "serviceTitanTenantId",
];

async function wipeSTCredentials() {
  const tenants = await db.select().from(tenantsTable);
  let updated = 0;

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
          .set({
            apiConfig: encryptConfig(config),
            serviceTitanId: null,
            stSyncPaused: true,
            updatedAt: new Date(),
          })
          .where(eq(tenantsTable.id, tenant.id));
        updated++;
        console.log(
          `[Wipe] Cleared ST credentials for tenant ${tenant.id} (${tenant.name})`,
        );
      }
    } catch (err) {
      console.error(`[Wipe] Failed to process tenant ${tenant.id}:`, err);
    }
  }

  console.log(`\nDone: ${updated} tenant(s) had ST credentials cleared.`);
  process.exit(0);
}

wipeSTCredentials().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
