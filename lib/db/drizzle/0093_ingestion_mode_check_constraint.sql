-- Harden tenant ingestion-mode storage before relying on dual-mode lead
-- creation in production. Older environments may have this column from a
-- one-time migration but no durable check constraint.
UPDATE tenants
SET lead_ingestion_mode = 'sheets'
WHERE lead_ingestion_mode IS NULL
  OR lead_ingestion_mode NOT IN ('sheets', 'both', 'tracker');

ALTER TABLE tenants
  ALTER COLUMN lead_ingestion_mode SET DEFAULT 'sheets';

ALTER TABLE tenants
  ALTER COLUMN lead_ingestion_mode SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_lead_ingestion_mode'
      AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT chk_lead_ingestion_mode
      CHECK (lead_ingestion_mode IN ('sheets', 'both', 'tracker'));
  END IF;
END $$;
