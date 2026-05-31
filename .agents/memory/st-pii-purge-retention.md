---
name: ServiceTitan PII purge & retention policy
description: Which ST job fields are purged at 24h vs retained forever, and the correct purged-row marker.
---

# ServiceTitan PII purge / retention

ServiceTitan has **no invoice number**. The job number (`invoice.job.number` / `stJob.number`)
IS the portal-findable invoice number. The internal `stInvoiceId` is an opaque API id and is
NOT searchable in the ST portal — never surface it to clients as "Invoice".

## Retention policy (relaxed from the original 24h-purge-everything)
- **Retained indefinitely:** `customerName`, `serviceAddress`, and `stJobNumber` (`st_job_number`).
  `stJobNumber` is a reference, not PII, and must NEVER be purged.
- **Still purged at 24h (set to NULL):** `customerPhone`, `customerEmail`, `stJobId`,
  `stCustomerId`, `stLocationId`.
- `hasAnyStPii` (in `st-data-purge.ts` and the historical one-time migration) must therefore
  exclude the retained fields, or retained rows get re-selected every cycle (inflated counts,
  needless rewrites).

## Purged-row marker (critical gotcha)
A purged row is detected by **`existing.stJobId === null`** — NOT by `customerName === null`.
**Why:** customerName is now retained, so keying the `wasPurged` check off it misclassifies
purged rows as live and the normal update branch rehydrates phone/email/internal ids on the
next ST sync, silently undoing the purge.
**How to apply:** any code in `sync-scheduler.ts` (job sync + backfill) deciding whether to
skip PII repopulation must use the nulled internal id (`stJobId`), since that is the field the
purge actually clears.
