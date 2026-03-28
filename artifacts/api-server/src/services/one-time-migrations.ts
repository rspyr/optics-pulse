import { db, tenantsTable, jobsTable, integrationSyncLogsTable } from "@workspace/db";
import { eq, and, sql, isNull, isNotNull, or } from "drizzle-orm";

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
      const now = new Date();
      const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const hasAnyStPii = or(
        isNotNull(jobsTable.customerName),
        isNotNull(jobsTable.customerPhone),
        isNotNull(jobsTable.customerEmail),
        isNotNull(jobsTable.serviceAddress),
        isNotNull(jobsTable.stJobId),
        isNotNull(jobsTable.stCustomerId),
        isNotNull(jobsTable.stLocationId),
      );

      const purged = await db.update(jobsTable)
        .set({
          customerName: null,
          customerPhone: null,
          customerEmail: null,
          serviceAddress: null,
          stJobId: null,
          stCustomerId: null,
          stLocationId: null,
          stDataExpiresAt: null,
          updatedAt: now,
        })
        .where(and(
          hasAnyStPii!,
          sql`${jobsTable.createdAt} <= ${cutoff}`,
        ))
        .returning({ id: jobsTable.id });
      console.log(`[Migration] Purged ST PII from ${purged.length} historical job(s) older than 24h`);

      const backfilled = await db.update(jobsTable)
        .set({
          stDataExpiresAt: sql`${jobsTable.createdAt} + interval '24 hours'`,
          updatedAt: now,
        })
        .where(and(
          hasAnyStPii!,
          isNull(jobsTable.stDataExpiresAt),
        ))
        .returning({ id: jobsTable.id });
      console.log(`[Migration] Backfilled stDataExpiresAt on ${backfilled.length} recent job(s) with ST PII`);
    },
  },
  {
    id: "2026-03-26_add-attribution-external-id",
    description: "Add external_id column to attribution_events table for CallRail sync deduplication",
    run: async () => {
      await db.execute(sql`
        ALTER TABLE attribution_events
        ADD COLUMN IF NOT EXISTS external_id TEXT
      `);
      console.log("[Migration] Added external_id column to attribution_events");

      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_attribution_events_external_id
        ON attribution_events (tenant_id, external_id)
        WHERE external_id IS NOT NULL
      `);
      console.log("[Migration] Created index on attribution_events(tenant_id, external_id)");
    },
  },
  {
    id: "2026-03-28_backfill-leads-hub-status",
    description: "Map existing lead_status values to new hub_status field for Leads Hub",
    run: async () => {
      await db.execute(sql`
        UPDATE leads SET hub_status = CASE
          WHEN status = 'new' THEN 'day_1'
          WHEN status = 'contacted' THEN 'day_2'
          WHEN status = 'booked' THEN 'appt_set'
          WHEN status = 'sold' THEN 'appt_set'
          WHEN status = 'lost' THEN 'day_5_old'
          WHEN status = 'cancelled' THEN 'dead'
          ELSE 'day_1'
        END
        WHERE hub_status = 'day_1' AND status != 'new'
      `);
      console.log("[Migration] Backfilled hub_status from existing lead_status values");

      await db.execute(sql`
        UPDATE call_attempts SET action_type = CASE
          WHEN method = 'call' THEN 'call'
          WHEN method = 'text' THEN 'text'
          WHEN method = 'email' THEN 'call'
          ELSE 'call'
        END
        WHERE action_type = 'call' AND method != 'call'
      `);
      console.log("[Migration] Backfilled action_type from existing call_attempts method values");
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
