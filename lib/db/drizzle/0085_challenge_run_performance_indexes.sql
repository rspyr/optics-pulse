CREATE INDEX IF NOT EXISTS leads_challenge_tenant_funnel_created_idx ON leads(tenant_id, funnel_id, created_at);
CREATE INDEX IF NOT EXISTS leads_challenge_tenant_lead_type_created_idx ON leads(tenant_id, LOWER(TRIM(lead_type)), created_at)
  WHERE funnel_id IS NULL AND lead_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_challenge_tenant_lead_status_idx ON jobs(tenant_id, lead_id, status);
CREATE INDEX IF NOT EXISTS sold_estimates_challenge_tenant_lead_idx ON sold_estimates(tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS sold_estimates_challenge_tenant_job_idx ON sold_estimates(tenant_id, job_id);
