-- One-time backfill of funnel_runs from existing lead and mapped Meta campaign
-- activity. This is a single data-modifying statement (atomic on its own) whose
-- source scans take only read locks, so it does not block writes; it runs in a
-- normal transaction and after 0085's indexes exist so the scans are fast. It
-- is idempotent via the NOT EXISTS guard on (tenant_id, funnel_type_id, start_date).
WITH lead_windows AS (
  SELECT
    l.tenant_id,
    ft.id AS funnel_type_id,
    MIN(l.created_at)::date AS start_date,
    MAX(l.created_at)::date AS end_date
  FROM leads l
  JOIN funnel_types ft
    ON ft.id = l.funnel_id
    OR (
      l.funnel_id IS NULL
      AND l.lead_type IS NOT NULL
      AND LOWER(TRIM(l.lead_type)) = LOWER(TRIM(ft.name))
    )
  GROUP BY l.tenant_id, ft.id
),
campaign_windows AS (
  SELECT
    c.tenant_id,
    cfm.funnel_type_id,
    MIN(cds.date)::date AS start_date,
    MAX(cds.date)::date AS end_date
  FROM campaign_funnel_mappings cfm
  JOIN campaigns c
    ON c.id = cfm.campaign_id
    AND c.tenant_id = cfm.tenant_id
  JOIN campaign_daily_stats cds
    ON cds.campaign_id = c.id
  WHERE c.platform = 'meta'
    AND (COALESCE(cds.spend, 0) > 0 OR COALESCE(cds.conversions, 0) > 0)
  GROUP BY c.tenant_id, cfm.funnel_type_id
),
combined_windows AS (
  SELECT
    tenant_id,
    funnel_type_id,
    MIN(start_date) AS start_date,
    MAX(end_date) AS end_date
  FROM (
    SELECT * FROM lead_windows
    UNION ALL
    SELECT * FROM campaign_windows
  ) windows
  WHERE start_date IS NOT NULL
    AND end_date IS NOT NULL
  GROUP BY tenant_id, funnel_type_id
),
assigned AS (
  INSERT INTO tenant_funnel_types (tenant_id, funnel_type_id)
  SELECT tenant_id, funnel_type_id
  FROM combined_windows
  ON CONFLICT DO NOTHING
  RETURNING tenant_id, funnel_type_id
)
INSERT INTO funnel_runs (
  tenant_id,
  funnel_type_id,
  name,
  start_date,
  end_date,
  status,
  notes
)
SELECT
  cw.tenant_id,
  cw.funnel_type_id,
  'Initial run' AS name,
  cw.start_date,
  CASE
    WHEN cw.end_date >= CURRENT_DATE - INTERVAL '14 days' THEN NULL
    ELSE cw.end_date
  END AS end_date,
  CASE
    WHEN cw.end_date >= CURRENT_DATE - INTERVAL '14 days' THEN 'active'::funnel_run_status
    ELSE 'ended'::funnel_run_status
  END AS status,
  'Automatically backfilled from existing lead and mapped Meta campaign activity.' AS notes
FROM combined_windows cw
WHERE NOT EXISTS (
  SELECT 1
  FROM funnel_runs fr
  WHERE fr.tenant_id = cw.tenant_id
    AND fr.funnel_type_id = cw.funnel_type_id
    AND fr.start_date = cw.start_date
);
