import { db, tenantsTable, jobsTable, integrationSyncLogsTable, leadsTable } from "@workspace/db";
import { eq, and, sql, isNull, isNotNull, or, ne, inArray } from "drizzle-orm";
import { emitLeadUpdated } from "../socket";
import { APPOINTMENT_JUNK_VALUES } from "../utils/appointment-validation";

interface Migration {
  id: string;
  description: string;
  run: () => Promise<void>;
}

const migrations: Migration[] = [
  {
    id: "2026-03-31_create-google-sheet-configs",
    description: "Create google_sheet_configs table and migrate existing sheet configs from tenant_funnel_types",
    run: async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS google_sheet_configs (
          id SERIAL PRIMARY KEY,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id),
          name TEXT NOT NULL,
          google_sheet_id TEXT NOT NULL,
          google_sheet_tab TEXT NOT NULL,
          column_mapping JSONB,
          mapping_headers JSONB,
          sync_row_watermark INTEGER,
          sync_paused BOOLEAN NOT NULL DEFAULT TRUE,
          default_funnel_type_id INTEGER REFERENCES funnel_types(id),
          funnel_column TEXT,
          funnel_value_map JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      console.log("[Migration] Created google_sheet_configs table");

      const colCheck = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tenant_funnel_types' AND column_name = 'google_sheet_id'
      `);

      if (colCheck.rows.length > 0) {
        const migrated = await db.execute(sql`
          INSERT INTO google_sheet_configs (tenant_id, name, google_sheet_id, google_sheet_tab, column_mapping, mapping_headers, sync_row_watermark, sync_paused, default_funnel_type_id, created_at)
          SELECT
            tft.tenant_id,
            COALESCE(ft.name, 'Sheet Config') AS name,
            tft.google_sheet_id,
            COALESCE(tft.google_sheet_tab, 'Sheet1'),
            tft.column_mapping,
            tft.mapping_headers,
            tft.sync_row_watermark,
            tft.sync_paused,
            tft.funnel_type_id AS default_funnel_type_id,
            tft.created_at
          FROM tenant_funnel_types tft
          JOIN funnel_types ft ON ft.id = tft.funnel_type_id
          WHERE tft.google_sheet_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM google_sheet_configs gsc
              WHERE gsc.tenant_id = tft.tenant_id
                AND gsc.google_sheet_id = tft.google_sheet_id
                AND gsc.default_funnel_type_id = tft.funnel_type_id
            )
          RETURNING id
        `);
        console.log(`[Migration] Migrated ${migrated.rows.length} sheet config(s) from tenant_funnel_types`);

        await db.execute(sql`
          ALTER TABLE tenant_funnel_types
            DROP COLUMN IF EXISTS google_sheet_id,
            DROP COLUMN IF EXISTS google_sheet_tab,
            DROP COLUMN IF EXISTS column_mapping,
            DROP COLUMN IF EXISTS mapping_headers,
            DROP COLUMN IF EXISTS sync_row_watermark,
            DROP COLUMN IF EXISTS sync_paused
        `);
        console.log("[Migration] Removed sheet columns from tenant_funnel_types");
      } else {
        console.log("[Migration] Sheet columns already removed from tenant_funnel_types — skipping data migration");
      }
    },
  },
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
        UPDATE leads SET hub_status = (CASE
          WHEN status = 'new' THEN 'day_1'
          WHEN status = 'contacted' THEN 'day_2'
          WHEN status = 'booked' THEN 'appt_set'
          WHEN status = 'sold' THEN 'appt_set'
          WHEN status = 'lost' THEN 'day_5_old'
          WHEN status = 'cancelled' THEN 'dead'
          ELSE 'day_1'
        END)::hub_status_enum
        WHERE hub_status = 'day_1'::hub_status_enum AND status != 'new'
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
  {
    id: "2026-03-31_backfill-appt-booked-from-date-time",
    description: "Set pre_booked=true and hub_status=appt_booked for leads that have appointment_date or appointment_time but were not flagged",
    run: async () => {
      const junkList = APPOINTMENT_JUNK_VALUES.map(v => `'${v}'`).join(", ");

      const updated = await db.execute(sql`
        UPDATE leads
        SET pre_booked = true,
            hub_status = 'appt_booked'::hub_status_enum,
            updated_at = NOW()
        WHERE pre_booked = false
          AND hub_status NOT IN ('appt_set', 'dead')
          AND (
            (appointment_date IS NOT NULL AND TRIM(appointment_date) != '' AND LOWER(TRIM(appointment_date)) NOT IN (${sql.raw(junkList)}))
            OR
            (appointment_time IS NOT NULL AND TRIM(appointment_time) != '' AND LOWER(TRIM(appointment_time)) NOT IN (${sql.raw(junkList)}))
          )
        RETURNING id, tenant_id
      `);

      const updatedRows = updated.rows as { id: number; tenant_id: number }[];
      console.log(`[Migration] Backfilled ${updatedRows.length} lead(s) with appointment data to appt_booked status`);

      if (updatedRows.length > 0) {
        const updatedIds = updatedRows.map(r => r.id);
        const leads = await db.select().from(leadsTable)
          .where(inArray(leadsTable.id, updatedIds));
        for (const lead of leads) {
          try {
            emitLeadUpdated(lead.tenantId, lead as unknown as Record<string, unknown>);
          } catch (err) {
            console.warn(`[Migration] Failed to emit lead-updated for lead ${lead.id}:`, err);
          }
        }
      }
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
