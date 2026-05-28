-- Store the audit trail of which line items were counted as rebates
-- (ETO, ODEE, ...) when adding back true revenue to a sold estimate.
-- Each entry is { "label": string, "amount": number }.
ALTER TABLE "sold_estimates"
  ADD COLUMN IF NOT EXISTS "rebate_breakdown" jsonb;
