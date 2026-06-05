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

-- funnel_runs is brand-new and empty, so these index builds are instant and
-- safe to run inside the migration transaction. The performance indexes on the
-- large existing tables (leads/jobs/sold_estimates) are built concurrently in
-- 0085, and the one-time backfill runs in 0086.
CREATE INDEX IF NOT EXISTS funnel_runs_tenant_id_idx ON funnel_runs(tenant_id);
CREATE INDEX IF NOT EXISTS funnel_runs_tenant_funnel_idx ON funnel_runs(tenant_id, funnel_type_id);
CREATE INDEX IF NOT EXISTS funnel_runs_tenant_funnel_start_idx ON funnel_runs(tenant_id, funnel_type_id, start_date);
CREATE INDEX IF NOT EXISTS funnel_runs_status_idx ON funnel_runs(status);
