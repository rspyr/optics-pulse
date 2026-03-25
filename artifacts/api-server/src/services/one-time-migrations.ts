import { db, tenantsTable, jobsTable, integrationSyncLogsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { decryptConfig, encryptConfig } from "../lib/encryption";

const ST_CREDENTIAL_KEYS = [
  "serviceTitanClientId",
  "serviceTitanClientSecret",
  "serviceTitanAppKey",
  "serviceTitanTenantId",
];

interface Migration {
  id: string;
  description: string;
  run: () => Promise<void>;
}

const migrations: Migration[] = [
  {
    id: "2026-03-25_wipe-servicetitan-data",
    description: "Wipe all ServiceTitan data, credentials, and pause ST sync for compliance",
    run: async () => {
      await db.delete(jobsTable);
      console.log("[Migration] Deleted all jobs");

      await db
        .delete(integrationSyncLogsTable)
        .where(eq(integrationSyncLogsTable.integration, "service_titan"));
      console.log("[Migration] Deleted all ServiceTitan sync logs");

      await db
        .update(tenantsTable)
        .set({ stSyncPaused: true, serviceTitanId: null, updatedAt: new Date() });
      console.log("[Migration] Paused ST sync and cleared service_titan_id for all tenants");

      const tenants = await db.select().from(tenantsTable);
      let cleared = 0;
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
            cleared++;
          }
        } catch (err) {
          console.error(`[Migration] Failed to clear ST credentials for tenant ${tenant.id}:`, err);
        }
      }
      console.log(`[Migration] Cleared ST credentials from ${cleared} tenant(s)`);
    },
  },
];

export async function runOneTimeMigrations(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS _one_time_migrations (
      id TEXT PRIMARY KEY,
      description TEXT,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const executed = await db.execute(sql`SELECT id FROM _one_time_migrations`);
  const executedIds = new Set((executed.rows as { id: string }[]).map((r) => r.id));

  const pending = migrations.filter((m) => !executedIds.has(m.id));

  if (pending.length === 0) {
    return;
  }

  console.log(`[Migrations] ${pending.length} one-time migration(s) to run`);

  for (const migration of pending) {
    console.log(`[Migrations] Running: ${migration.id} — ${migration.description}`);
    try {
      await migration.run();
      await db.execute(
        sql`INSERT INTO _one_time_migrations (id, description) VALUES (${migration.id}, ${migration.description})`
      );
      console.log(`[Migrations] Completed: ${migration.id}`);
    } catch (err) {
      console.error(`[Migrations] FAILED: ${migration.id}`, err);
      throw err;
    }
  }

  console.log(`[Migrations] All one-time migrations complete`);
}
