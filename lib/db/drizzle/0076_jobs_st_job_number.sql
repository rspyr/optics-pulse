-- Task #819: ServiceTitan has no invoice number — an invoice is identified by
-- its job number (invoice.job.number), which is also the human-readable job
-- number. We previously stored only the internal 64-bit ids (st_job_id,
-- st_invoice_id) which are not searchable in the ServiceTitan portal. Add a
-- dedicated column for the portal-findable job/invoice number. It is a
-- reference (not PII) and is never purged by the 24h ST data purge.
ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "st_job_number" text;
