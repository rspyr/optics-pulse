DO $$
BEGIN
  CREATE TYPE funnel_run_status AS ENUM ('active', 'ended', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS funnel_runs (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  funnel_type_id INTEGER NOT NULL REFERENCES funnel_types(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  status funnel_run_status NOT NULL DEFAULT 'active',
  notes TEXT,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS funnel_runs_tenant_id_idx ON funnel_runs(tenant_id);
CREATE INDEX IF NOT EXISTS funnel_runs_tenant_funnel_idx ON funnel_runs(tenant_id, funnel_type_id);
CREATE INDEX IF NOT EXISTS funnel_runs_tenant_funnel_start_idx ON funnel_runs(tenant_id, funnel_type_id, start_date);
CREATE INDEX IF NOT EXISTS funnel_runs_status_idx ON funnel_runs(status);
CREATE INDEX IF NOT EXISTS leads_challenge_tenant_funnel_created_idx ON leads(tenant_id, funnel_id, created_at);
CREATE INDEX IF NOT EXISTS leads_challenge_tenant_lead_type_created_idx ON leads(tenant_id, LOWER(TRIM(lead_type)), created_at)
  WHERE funnel_id IS NULL AND lead_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_challenge_tenant_lead_status_idx ON jobs(tenant_id, lead_id, status);
CREATE INDEX IF NOT EXISTS sold_estimates_challenge_tenant_lead_idx ON sold_estimates(tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS sold_estimates_challenge_tenant_job_idx ON sold_estimates(tenant_id, job_id);

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
