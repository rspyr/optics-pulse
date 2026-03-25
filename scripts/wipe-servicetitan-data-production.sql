-- =============================================================
-- Production Script: Wipe All ServiceTitan Data & Pause ST Sync
-- =============================================================
-- This script:
--   1. Deletes all jobs from the jobs table (ServiceTitan-sourced)
--   2. Deletes all ServiceTitan sync logs
--   3. Pauses ST sync for ALL tenants
--   4. Clears ServiceTitan tenant ID references
--   5. Specifically ensures "Advantage Heating & Cooling" is paused
--
-- NOTE: ServiceTitan credentials stored in the encrypted api_config
-- JSONB column cannot be cleared via raw SQL (they are AES-256-GCM
-- encrypted). Use the companion script wipe-st-credentials.ts to
-- clear those via the application's decryption/encryption layer.
--
-- Run with: psql $DATABASE_URL -f scripts/wipe-servicetitan-data-production.sql
-- =============================================================

BEGIN;

-- 1. Delete all jobs (all sourced from ServiceTitan)
DELETE FROM jobs;

-- 2. Delete ServiceTitan integration sync logs
DELETE FROM integration_sync_logs WHERE integration = 'service_titan';

-- 3. Pause ServiceTitan sync for ALL tenants and clear ST tenant ID
UPDATE tenants
SET st_sync_paused = true,
    service_titan_id = NULL,
    updated_at = NOW();

-- 4. Explicitly ensure Advantage Heating & Cooling is paused
UPDATE tenants
SET st_sync_paused = true,
    service_titan_id = NULL,
    updated_at = NOW()
WHERE name = 'Advantage Heating & Cooling';

COMMIT;

-- Verification queries
SELECT 'Jobs remaining:' AS check, COUNT(*) AS count FROM jobs;
SELECT 'ST sync logs remaining:' AS check, COUNT(*) AS count FROM integration_sync_logs WHERE integration = 'service_titan';
SELECT name, st_sync_paused, service_titan_id, is_active FROM tenants ORDER BY id;
