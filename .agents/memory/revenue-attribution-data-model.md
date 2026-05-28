---
name: Revenue attribution data model
description: Where rebate-corrected job revenue and itemized rebate breakdown actually live in Marketing OS
---

# Rebate-corrected revenue & itemized breakdown

- Corrected revenue per job = `COALESCE(invoiceTotal + COALESCE(invoiceRebateAmount,0), revenue)`. This is the canonical math used by `/drilldown/jobs` and `/dashboard/spend-revenue`; reuse it everywhere so Command Center totals reconcile.
- The `jobs` table only stores the SCALAR `invoiceRebateAmount` — there is NO itemized rebate JSONB on jobs.
- The ITEMIZED rebate breakdown (`RebateBreakdownItem[]` = {label, amount}) lives ONLY on `sold_estimates.rebateBreakdown`. To show itemized add-backs per job, join `sold_estimates` by `jobId`.
- Salesperson ("sold by") for a job comes from `sold_estimates.soldByName`, fallback `leads.assignedTo`.

**Why:** Multiple surfaces need rebate-inclusive revenue; computing it differently causes drilldown totals to diverge from the dashboard.

**How to apply:** For any "revenue by job" view, fetch jobs with the COALESCE expr, then enrich from sold_estimates for itemized rebates + soldByName.
