import { db, tenantsTable, jobsTable, integrationSyncLogsTable, leadsTable, leadSourceAliasesTable } from "@workspace/db";
import { eq, and, sql, isNull, isNotNull, or, ne, inArray, desc } from "drizzle-orm";
import { emitLeadUpdated } from "../socket";
import { APPOINTMENT_JUNK_VALUES } from "../utils/appointment-validation";
import { DEFAULT_SOURCE_ALIASES, normalizeSource } from "./source-normalizer";

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
  {
    id: "2026-03-31_dedup-automation-rules",
    description: "Purge duplicate automation rules, reassign alerts, and add unique constraint",
    run: async () => {
      interface DupeGroup {
        name: string;
        condition_type: string;
        condition_value: number;
        action_type: string;
        platform: string;
        tenant_id: string;
        keep_id: number;
        cnt: number;
      }

      const dupeGroups = await db.execute(sql`
        SELECT name, condition_type, condition_value, action_type,
               COALESCE(platform, '') AS platform,
               COALESCE(tenant_id::text, '') AS tenant_id,
               MIN(id) AS keep_id,
               COUNT(*) AS cnt
        FROM automation_rules
        GROUP BY name, condition_type, condition_value, action_type,
                 COALESCE(platform, ''), COALESCE(tenant_id::text, '')
        HAVING COUNT(*) > 1
      `);

      let totalDeleted = 0;
      for (const group of dupeGroups.rows as DupeGroup[]) {
        const keepId = Number(group.keep_id);
        const tenantFilter = group.tenant_id === ''
          ? sql`tenant_id IS NULL`
          : sql`tenant_id = ${Number(group.tenant_id)}`;
        const platformFilter = group.platform === ''
          ? sql`platform IS NULL`
          : sql`platform = ${group.platform}`;

        await db.execute(sql`
          UPDATE automation_alerts
          SET rule_id = ${keepId}
          WHERE rule_id IN (
            SELECT id FROM automation_rules
            WHERE name = ${group.name}
              AND condition_type = ${group.condition_type}
              AND condition_value = ${Number(group.condition_value)}
              AND action_type = ${group.action_type}
              AND ${platformFilter}
              AND ${tenantFilter}
              AND id != ${keepId}
          )
        `);

        const deleted = await db.execute(sql`
          DELETE FROM automation_rules
          WHERE name = ${group.name}
            AND condition_type = ${group.condition_type}
            AND condition_value = ${Number(group.condition_value)}
            AND action_type = ${group.action_type}
            AND ${platformFilter}
            AND ${tenantFilter}
            AND id != ${keepId}
          RETURNING id
        `);
        totalDeleted += deleted.rows.length;
      }
      console.log(`[Migration] Deleted ${totalDeleted} duplicate automation rule(s)`);

      const conflicts = await db.execute(sql`
        SELECT name, condition_type, COALESCE(tenant_id, -1) AS tid, COUNT(*) AS cnt
        FROM automation_rules
        GROUP BY name, condition_type, COALESCE(tenant_id, -1)
        HAVING COUNT(*) > 1
      `);
      if (conflicts.rows.length > 0) {
        for (const c of conflicts.rows as { name: string; condition_type: string; tid: number; cnt: number }[]) {
          const tidFilter = Number(c.tid) === -1 ? sql`tenant_id IS NULL` : sql`tenant_id = ${Number(c.tid)}`;
          const keepResult = await db.execute(sql`
            SELECT MIN(id) AS keep_id FROM automation_rules
            WHERE name = ${c.name} AND condition_type = ${c.condition_type} AND ${tidFilter}
          `);
          const keepId = Number((keepResult.rows[0] as { keep_id: number }).keep_id);
          await db.execute(sql`
            UPDATE automation_alerts SET rule_id = ${keepId}
            WHERE rule_id IN (
              SELECT id FROM automation_rules
              WHERE name = ${c.name} AND condition_type = ${c.condition_type} AND ${tidFilter} AND id != ${keepId}
            )
          `);
          const del = await db.execute(sql`
            DELETE FROM automation_rules
            WHERE name = ${c.name} AND condition_type = ${c.condition_type} AND ${tidFilter} AND id != ${keepId}
            RETURNING id
          `);
          console.log(`[Migration] Resolved ${del.rows.length} index-key conflict(s) for rule "${c.name}" / ${c.condition_type}`);
        }
      }

      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_rule_identity
        ON automation_rules (name, condition_type, COALESCE(tenant_id, -1))
      `);
      console.log("[Migration] Created unique index uq_automation_rule_identity on automation_rules");
    },
  },
  {
    id: "2026-03-31_recreate-automation-rule-unique-index",
    description: "Ensure unique index on automation_rules exists (recreate after deploy-system drop)",
    run: async () => {
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_rule_identity
        ON automation_rules (name, condition_type, COALESCE(tenant_id, -1))
      `);
      console.log("[Migration] Ensured unique index uq_automation_rule_identity exists on automation_rules");
    },
  },
  {
    id: "2026-03-31_wipe-automation-alerts",
    description: "Purge all automation alerts generated from duplicate rules",
    run: async () => {
      const deleted = await db.execute(sql`DELETE FROM automation_alerts RETURNING id`);
      console.log(`[Migration] Deleted ${deleted.rows.length} automation alert(s)`);
    },
  },
  {
    id: "2026-03-31_create-lead-source-aliases",
    description: "Create lead_source_aliases table and seed default aliases for all tenants, then backfill existing leads",
    run: async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS lead_source_aliases (
          id SERIAL PRIMARY KEY,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id),
          canonical_name TEXT NOT NULL,
          alias TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_alias
        ON lead_source_aliases (tenant_id, alias)
      `);
      console.log("[Migration] Created lead_source_aliases table");

      const tenants = await db.select({ id: tenantsTable.id }).from(tenantsTable);
      let totalSeeded = 0;
      for (const tenant of tenants) {
        for (const group of DEFAULT_SOURCE_ALIASES) {
          for (const alias of group.aliases) {
            const existing = await db.select().from(leadSourceAliasesTable)
              .where(and(
                eq(leadSourceAliasesTable.tenantId, tenant.id),
                eq(leadSourceAliasesTable.alias, alias.toLowerCase())
              ));
            if (existing.length === 0) {
              await db.insert(leadSourceAliasesTable).values({
                tenantId: tenant.id,
                canonicalName: group.canonicalName,
                alias: alias.toLowerCase(),
              });
              totalSeeded++;
            }
          }
        }
      }
      console.log(`[Migration] Seeded ${totalSeeded} default alias(es) across ${tenants.length} tenant(s)`);

      let totalUpdated = 0;
      for (const tenant of tenants) {
        const leads = await db.select({ id: leadsTable.id, source: leadsTable.source })
          .from(leadsTable)
          .where(eq(leadsTable.tenantId, tenant.id));
        for (const lead of leads) {
          const normalized = await normalizeSource(tenant.id, lead.source);
          if (normalized !== lead.source) {
            await db.update(leadsTable)
              .set({ source: normalized, updatedAt: new Date() })
              .where(eq(leadsTable.id, lead.id));
            totalUpdated++;
          }
        }
      }
      console.log(`[Migration] Backfilled ${totalUpdated} lead source(s) across ${tenants.length} tenant(s)`);
    },
  },
  {
    id: "2026-03-31_add-booked-by-csr-id",
    description: "Add booked_by_csr_id column to leads and backfill existing booked/sold leads",
    run: async () => {
      await db.execute(sql`
        ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS booked_by_csr_id INTEGER REFERENCES users(id)
      `);
      console.log("[Migration] Ensured booked_by_csr_id column exists on leads");

      const backfilled = await db.execute(sql`
        UPDATE leads
        SET booked_by_csr_id = assigned_csr_id
        WHERE status IN ('booked', 'sold')
          AND booked_by_csr_id IS NULL
          AND assigned_csr_id IS NOT NULL
        RETURNING id
      `);
      console.log(`[Migration] Backfilled booked_by_csr_id on ${backfilled.rows.length} existing booked/sold lead(s)`);
    },
  },
  {
    id: "2026-03-31_add-assigned-at",
    description: "Add assigned_at column to leads for speed-to-lead tracking and backfill from created_at",
    run: async () => {
      await db.execute(sql`
        ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      `);
      console.log("[Migration] Ensured assigned_at column exists on leads");

      const backfilled = await db.execute(sql`
        UPDATE leads
        SET assigned_at = created_at
        WHERE assigned_at = (SELECT MAX(assigned_at) FROM leads)
          OR assigned_at > updated_at
        RETURNING id
      `);
      console.log(`[Migration] Backfilled assigned_at from created_at on ${backfilled.rows.length} lead(s)`);
    },
  },
  {
    id: "2026-03-31_create-user-login-sessions",
    description: "Create user_login_sessions table for tracking login/logout times",
    run: async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS user_login_sessions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id),
          tenant_id INTEGER REFERENCES tenants(id),
          session_key TEXT,
          login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          logout_at TIMESTAMPTZ
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS user_login_sessions_user_id_idx ON user_login_sessions(user_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS user_login_sessions_user_login_idx ON user_login_sessions(user_id, login_at)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS user_login_sessions_session_key_idx ON user_login_sessions(session_key)`);
      console.log("[Migration] Created user_login_sessions table with indexes");
    },
  },
  {
    id: "2026-03-31_add-session-key-to-login-sessions",
    description: "Add session_key column to user_login_sessions for per-session tracking",
    run: async () => {
      await db.execute(sql`ALTER TABLE user_login_sessions ADD COLUMN IF NOT EXISTS session_key TEXT`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS user_login_sessions_session_key_idx ON user_login_sessions(session_key)`);
      console.log("[Migration] Added session_key column to user_login_sessions");
    },
  },
  {
    id: "2026-04-01_create-podium-messages",
    description: "Create podium_messages table and add podium_contact_uid column to leads for Podium integration",
    run: async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS podium_messages (
          id SERIAL PRIMARY KEY,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id),
          lead_id INTEGER REFERENCES leads(id),
          podium_conversation_uid TEXT NOT NULL,
          podium_message_uid TEXT NOT NULL,
          direction TEXT NOT NULL DEFAULT 'inbound',
          body TEXT,
          channel_type TEXT DEFAULT 'sms',
          sender_name TEXT,
          delivery_status TEXT DEFAULT 'delivered',
          podium_created_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(tenant_id, podium_message_uid)
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS podium_messages_tenant_lead_idx ON podium_messages(tenant_id, lead_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS podium_messages_conversation_idx ON podium_messages(podium_conversation_uid)`);
      console.log("[Migration] Created podium_messages table with indexes");

      await db.execute(sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS podium_contact_uid TEXT`);
      console.log("[Migration] Added podium_contact_uid column to leads");
    },
  },
  {
    id: "2026-04-01_add-user-podium-config",
    description: "Add podium_config column to users table for per-user Podium OAuth credentials",
    run: async () => {
      await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS podium_config TEXT`);
      console.log("[Migration] Added podium_config column to users table");
    },
  },
  {
    id: "2026-04-02_create-push-tokens",
    description: "Create push_tokens table for mobile push notifications",
    run: async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS push_tokens (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token TEXT NOT NULL,
          platform TEXT NOT NULL DEFAULT 'expo',
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          UNIQUE(user_id, token)
        )
      `);
      console.log("[Migration] Created push_tokens table");
    },
  },
  {
    id: "2026-04-03_backfill-lead-type-from-funnel",
    description: "Backfill lead_type from funnel_types.name for leads ingested via Google Sheets that have funnel_id but missing lead_type",
    run: async () => {
      const result = await db.execute(sql`
        UPDATE leads
        SET lead_type = ft.name,
            updated_at = NOW()
        FROM funnel_types ft
        WHERE leads.funnel_id = ft.id
          AND (leads.lead_type IS NULL OR leads.lead_type = '')
        RETURNING leads.id
      `);
      console.log(`[Migration] Backfilled lead_type on ${result.rows.length} lead(s) from funnel_types.name`);
    },
  },
  {
    id: "2026-04-03_add-podium-message-items",
    description: "Add message_items jsonb column to podium_messages for Podium V4 items[] payload",
    run: async () => {
      await db.execute(sql`
        ALTER TABLE podium_messages
        ADD COLUMN IF NOT EXISTS message_items JSONB
      `);
      console.log("[Migration] Added message_items column to podium_messages");
    },
  },
  {
    id: "2026-04-07_create-pg-trgm-indexes",
    description: "Create pg_trgm extension and GIN indexes on leads for fuzzy search",
    run: async () => {
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      console.log("[Migration] Ensured pg_trgm extension exists");

      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS leads_first_name_trgm
        ON leads USING gin (first_name gin_trgm_ops)
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS leads_last_name_trgm
        ON leads USING gin (last_name gin_trgm_ops)
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS leads_email_trgm
        ON leads USING gin (email gin_trgm_ops)
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS leads_phone_trgm
        ON leads USING gin (phone gin_trgm_ops)
      `);
      console.log("[Migration] Created GIN trigram indexes on leads (first_name, last_name, email, phone)");
    },
  },
  {
    id: "2026-04-07_realign-assigned-csr-for-booked-leads",
    description: "Realign assigned_csr_id to match booked_by_csr_id on booked leads where they differ",
    run: async () => {
      const mismatched = await db.execute(sql`
        SELECT id, assigned_csr_id AS old_assigned, booked_by_csr_id
        FROM leads
        WHERE hub_status IN ('appt_set', 'appt_booked')
          AND booked_by_csr_id IS NOT NULL
          AND assigned_csr_id IS DISTINCT FROM booked_by_csr_id
      `);
      const mismatchedRows = mismatched.rows as { id: number; old_assigned: number | null; booked_by_csr_id: number }[];

      if (mismatchedRows.length > 0) {
        const ids = mismatchedRows.map(r => r.id);
        await db.update(leadsTable)
          .set({
            assignedCsrId: sql`booked_by_csr_id`,
            updatedAt: new Date(),
          })
          .where(inArray(leadsTable.id, ids));
        console.log(`[Migration] Realigned assigned_csr_id on ${mismatchedRows.length} booked lead(s) to match booked_by_csr_id`);
        for (const row of mismatchedRows) {
          console.log(`[Migration]   Lead ${row.id}: assigned_csr_id ${row.old_assigned} -> ${row.booked_by_csr_id}`);
        }
      } else {
        console.log(`[Migration] No mismatched assigned_csr_id found on booked leads`);
      }
    },
  },
  {
    id: "2026-04-08_add-lead-id-and-backfill",
    description: "Add lead_id FK column to jobs table, create index, and backfill linkages from phone/email",
    run: async () => {
      await db.execute(sql`
        ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES leads(id)
      `);
      console.log("[Migration] Added lead_id column to jobs table");

      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS idx_jobs_lead_id ON jobs(lead_id) WHERE lead_id IS NOT NULL
      `);
      console.log("[Migration] Created partial index on jobs.lead_id");

      const jobsToMatch = await db.select({
        id: jobsTable.id,
        tenantId: jobsTable.tenantId,
        customerPhone: jobsTable.customerPhone,
        customerEmail: jobsTable.customerEmail,
      }).from(jobsTable).where(
        and(
          isNull(jobsTable.leadId),
          or(isNotNull(jobsTable.customerPhone), isNotNull(jobsTable.customerEmail)),
        ),
      );

      let matched = 0;

      if (jobsToMatch.length === 0) {
        console.log("[Migration] No jobs with PII available for phone/email backfill phase");
      } else {
        console.log(`[Migration] Phase 1: Attempting lead_id backfill for ${jobsToMatch.length} jobs with phone/email`);
      }

      for (const job of jobsToMatch) {
        const orClauses: ReturnType<typeof sql>[] = [];
        if (job.customerPhone) {
          orClauses.push(
            sql`(${leadsTable.phone} IS NOT NULL AND ${leadsTable.phone} != '' AND ${leadsTable.phone} = ${job.customerPhone})`,
          );
        }
        if (job.customerEmail) {
          orClauses.push(
            sql`(${leadsTable.email} IS NOT NULL AND ${leadsTable.email} != '' AND LOWER(${leadsTable.email}) = LOWER(${job.customerEmail}))`,
          );
        }
        if (orClauses.length === 0) continue;

        const orClause = orClauses.length === 1 ? orClauses[0] : sql`(${sql.join(orClauses, sql` OR `)})`;
        const [lead] = await db.select({ id: leadsTable.id })
          .from(leadsTable)
          .where(and(eq(leadsTable.tenantId, job.tenantId), orClause))
          .orderBy(desc(leadsTable.createdAt))
          .limit(1);

        if (lead) {
          await db.update(jobsTable)
            .set({ leadId: lead.id, updatedAt: new Date() })
            .where(eq(jobsTable.id, job.id));
          matched++;
        }
      }

      console.log(`[Migration] Phase 1 complete: ${matched}/${jobsToMatch.length} jobs linked via phone/email`);

      const purgedJobs = await db.select({
        id: jobsTable.id,
        tenantId: jobsTable.tenantId,
        matchedGclid: jobsTable.matchedGclid,
        customerName: jobsTable.customerName,
      }).from(jobsTable).where(
        and(
          isNull(jobsTable.leadId),
          isNull(jobsTable.customerPhone),
          isNull(jobsTable.customerEmail),
        ),
      );

      if (purgedJobs.length > 0) {
        console.log(`[Migration] Phase 2: Attempting fallback backfill for ${purgedJobs.length} purged jobs via gclid/name`);
        let gclidMatched = 0;
        let nameMatched = 0;

        for (const job of purgedJobs) {
          if (job.matchedGclid) {
            const [lead] = await db.select({ id: leadsTable.id })
              .from(leadsTable)
              .where(and(eq(leadsTable.tenantId, job.tenantId), eq(leadsTable.matchedGclid, job.matchedGclid)))
              .limit(1);
            if (lead) {
              await db.update(jobsTable)
                .set({ leadId: lead.id, updatedAt: new Date() })
                .where(eq(jobsTable.id, job.id));
              gclidMatched++;
              continue;
            }
          }

          if (job.customerName) {
            const nameParts = job.customerName.split(" ");
            const firstName = nameParts[0] || "";
            const lastName = nameParts.slice(1).join(" ") || "";
            const nameConditions = [eq(leadsTable.tenantId, job.tenantId), eq(leadsTable.firstName, firstName)];
            if (lastName) nameConditions.push(eq(leadsTable.lastName, lastName));
            const [lead] = await db.select({ id: leadsTable.id })
              .from(leadsTable)
              .where(and(...nameConditions))
              .orderBy(desc(leadsTable.createdAt))
              .limit(1);
            if (lead) {
              await db.update(jobsTable)
                .set({ leadId: lead.id, updatedAt: new Date() })
                .where(eq(jobsTable.id, job.id));
              nameMatched++;
              continue;
            }
          }
        }

        console.log(`[Migration] Phase 2 complete: ${gclidMatched} via gclid, ${nameMatched} via name, ${purgedJobs.length - gclidMatched - nameMatched} remain unlinked`);
      } else {
        console.log("[Migration] Phase 2: No purged jobs without lead_id found");
      }

      const remainingUnlinked = await db.select({ count: sql<number>`COUNT(*)` })
        .from(jobsTable)
        .where(isNull(jobsTable.leadId));
      console.log(`[Migration] Final state: ${Number(remainingUnlinked[0]?.count ?? 0)} total jobs with no lead_id (purged before lead matching, no surviving identifiers to match)`);
    },
  },
  {
    id: "2026-04-08_seed-client-slugs",
    description: "Seed clientSlug on tenants from slugified tenant name",
    run: async () => {
      const tenants = await db.select({ id: tenantsTable.id, name: tenantsTable.name }).from(tenantsTable);
      const usedSlugs = new Set<string>();
      for (const t of tenants) {
        let slug = t.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        if (!slug) slug = `tenant-${t.id}`;
        while (usedSlugs.has(slug)) {
          slug = `${slug}-${t.id}`;
        }
        usedSlugs.add(slug);
        await db.update(tenantsTable)
          .set({ clientSlug: slug })
          .where(eq(tenantsTable.id, t.id));
      }
      console.log(`[Migrations] Seeded clientSlug for ${tenants.length} tenants`);
    },
  },
  {
    id: "2026-04-08_unique-client-slug",
    description: "Add unique index on tenants.client_slug for tracker script identification",
    run: async () => {
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_client_slug ON tenants (client_slug) WHERE client_slug IS NOT NULL`);
      console.log("[Migration] Created unique index uq_tenant_client_slug on tenants");
    },
  },
  {
    id: "2026-04-08_add-tracker-columns",
    description: "Add tracker attribution columns to attribution_events and client_slug to tenants",
    run: async () => {
      await db.execute(sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS client_slug TEXT`);
      console.log("[Migration] Ensured client_slug column on tenants");

      await db.execute(sql`ALTER TABLE attribution_events ADD COLUMN IF NOT EXISTS utm_term TEXT`);
      await db.execute(sql`ALTER TABLE attribution_events ADD COLUMN IF NOT EXISTS utm_content TEXT`);
      await db.execute(sql`ALTER TABLE attribution_events ADD COLUMN IF NOT EXISTS msclkid TEXT`);
      await db.execute(sql`ALTER TABLE attribution_events ADD COLUMN IF NOT EXISTS ttclid TEXT`);
      await db.execute(sql`ALTER TABLE attribution_events ADD COLUMN IF NOT EXISTS li_fat_id TEXT`);
      await db.execute(sql`ALTER TABLE attribution_events ADD COLUMN IF NOT EXISTS referrer TEXT`);
      await db.execute(sql`ALTER TABLE attribution_events ADD COLUMN IF NOT EXISTS page_url TEXT`);
      await db.execute(sql`ALTER TABLE attribution_events ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP`);
      await db.execute(sql`ALTER TABLE attribution_events ADD COLUMN IF NOT EXISTS form_type TEXT`);
      await db.execute(sql`ALTER TABLE attribution_events ADD COLUMN IF NOT EXISTS form_id TEXT`);
      await db.execute(sql`ALTER TABLE attribution_events ADD COLUMN IF NOT EXISTS form_name TEXT`);
      await db.execute(sql`ALTER TABLE attribution_events ADD COLUMN IF NOT EXISTS form_fields JSONB`);
      console.log("[Migration] Ensured all tracker columns on attribution_events");
    },
  },
  {
    id: "2026-04-08_enforce-client-slug-not-null",
    description: "Set NOT NULL on tenants.client_slug after seeding, ensuring all tenants have a slug",
    run: async () => {
      const missing = await db.execute(sql`SELECT id, name FROM tenants WHERE client_slug IS NULL`);
      for (const row of missing.rows as Array<{ id: number; name: string }>) {
        const slug = (row.name || `tenant-${row.id}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `tenant-${row.id}`;
        await db.execute(sql`UPDATE tenants SET client_slug = ${slug + '-' + row.id} WHERE id = ${row.id}`);
      }
      await db.execute(sql`ALTER TABLE tenants ALTER COLUMN client_slug SET NOT NULL`);
      await db.execute(sql`DROP INDEX IF EXISTS uq_tenant_client_slug`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_client_slug ON tenants (client_slug)`);
      console.log("[Migration] Enforced NOT NULL + unique constraint on tenants.client_slug");
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
