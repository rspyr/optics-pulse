-- =============================================================
-- Production Script: Wipe All ServiceTitan Data & Pause ST Sync
-- =============================================================
-- This script:
--   1. Deletes all jobs from the jobs table (ServiceTitan-sourced)
--   2. Deletes all ServiceTitan sync logs
--   3. Pauses ST sync for ALL tenants
--   4. Specifically ensures "Advantage Heating & Cooling" is paused
--
-- Run with: psql $DATABASE_URL -f scripts/wipe-servicetitan-data-production.sql
-- =============================================================

BEGIN;

-- 1. Delete all jobs (all sourced from ServiceTitan)
DELETE FROM jobs;

-- 2. Delete ServiceTitan integration sync logs
DELETE FROM integration_sync_logs WHERE integration = 'service_titan';

-- 3. Pause ServiceTitan sync for ALL tenants
UPDATE tenants SET st_sync_paused = true, updated_at = NOW();

-- 4. Verify Advantage Heating & Cooling is paused (redundant but explicit)
UPDATE tenants
SET st_sync_paused = true, updated_at = NOW()
WHERE name = 'Advantage Heating & Cooling';

COMMIT;

-- Verification queries
SELECT 'Jobs remaining:' AS check, COUNT(*) AS count FROM jobs;
SELECT 'ST sync logs remaining:' AS check, COUNT(*) AS count FROM integration_sync_logs WHERE integration = 'service_titan';
SELECT name, st_sync_paused, is_active FROM tenants ORDER BY id;
