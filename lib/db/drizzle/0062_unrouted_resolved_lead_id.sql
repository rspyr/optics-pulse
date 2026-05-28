-- Track the lead that an unrouted sheet row produced when the operator
-- sends it to a funnel. Lets the panel show a confirmation + deep link
-- to the new lead, and lets historical (resolved) rows be audited
-- against the lead they became.
ALTER TABLE "unrouted_sheet_rows"
  ADD COLUMN IF NOT EXISTS "resolved_lead_id" integer;
