-- Task #753: Use real per-client budgets in the agency overview instead of a
-- flat default. Each tenant now stores its own monthly ad-spend budget (in whole
-- dollars). A NULL value means "no budget configured" and application code falls
-- back to the MONTHLY_BUDGET_DEFAULT constant so existing tenants keep working.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "monthly_budget" integer;
