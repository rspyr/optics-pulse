ALTER TYPE hub_status_enum ADD VALUE IF NOT EXISTS 'appt_booked';

ALTER TABLE leads ADD COLUMN IF NOT EXISTS pre_booked boolean NOT NULL DEFAULT false;