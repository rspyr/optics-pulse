import { db, tenantsTable, jobsTable, integrationSyncLogsTable } from "@workspace/db";
import { eq, sql, isNotNull, or } from "drizzle-orm";

interface Migration {
  id: string;
  description: string;
  run: () => Promise<void>;
}

const migrations: Migration[] = [
  {
    id: "2026-03-25_wipe-servicetitan-data",
    description: "Wipe ST jobs/logs and pause ST sync for compliance (credentials preserved)",
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
    },
  },
  {
    id: "2026-03-26_purge-historical-st-pii",
    description: "NULL out ST PII fields on all existing jobs for 24h data retention compliance",
    run: async () => {
      const result = await db.update(jobsTable)
        .set({
          customerName: null,
          customerPhone: null,
          customerEmail: null,
          serviceAddress: null,
          stJobId: null,
          stCustomerId: null,
          stLocationId: null,
          stDataExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(or(
          isNotNull(jobsTable.customerName),
          isNotNull(jobsTable.customerPhone),
          isNotNull(jobsTable.customerEmail),
          isNotNull(jobsTable.serviceAddress),
          isNotNull(jobsTable.stJobId),
          isNotNull(jobsTable.stCustomerId),
          isNotNull(jobsTable.stLocationId),
        ))
        .returning({ id: jobsTable.id });
      console.log(`[Migration] Purged ST PII from ${result.length} historical job(s)`);
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
