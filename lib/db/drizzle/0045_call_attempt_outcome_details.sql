-- Persist the per-attempt follow-up outcome detail (spoke result + the
-- timing fields the operator chose) directly on the call_attempts row,
-- so re-opening a past attempt for editing in the Pulse history editor
-- pre-fills the originally-entered values instead of falling back to
-- the form's defaults (now+1h callback, tomorrow 09:00 appointment).
--
-- Before this migration these fields were only mirrored onto the parent
-- `leads` row, which made it impossible to attribute callback /
-- appointment / dead detail to a specific historical attempt — so the
-- history endpoint had to guess (most-recent spoke_with_customer
-- attempt) and the edit form lost the values across re-opens.
--
-- All four columns are nullable: legacy rows stay null, and the
-- /leads-hub/:leadId/history + /podium/timeline/:leadId handlers fall
-- back to the lead-row mirror for the driving attempt when the
-- per-attempt column is null.

ALTER TABLE "call_attempts" ADD COLUMN IF NOT EXISTS "spoke_result" text;
ALTER TABLE "call_attempts" ADD COLUMN IF NOT EXISTS "callback_at" timestamp;
ALTER TABLE "call_attempts" ADD COLUMN IF NOT EXISTS "appointment_date" text;
ALTER TABLE "call_attempts" ADD COLUMN IF NOT EXISTS "appointment_time" text;
