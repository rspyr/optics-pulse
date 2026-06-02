---
name: ServiceTitan PII purge & retention policy
description: Which ST job fields are purged at 24h vs retained forever, and the correct purged-row marker.
---

# ServiceTitan PII purge / retention

ServiceTitan has **no invoice number**. The job number (`invoice.job.number` / `stJob.number`)
IS the portal-findable invoice number. The internal `stInvoiceId` is an opaque API id and is
NOT searchable in the ST portal — never surface it to clients as "Invoice".

## Retention policy (relaxed from the original 24h-purge-everything)
- **Retained indefinitely:** `customerName`, `serviceAddress`, `customerPhone`, `customerEmail`,
  and `stJobNumber` (`st_job_number`). Phone/email retention is an operator decision (keep them
  so revenue-attribution + lead matching keep working past 24h). `stJobNumber` is a reference,
  not PII, and must NEVER be purged.
- **Still purged (set to NULL):** the internal ids only — `stJobId`, `stCustomerId`,
  `stLocationId`.
- `hasAnyStPii` (in `st-data-purge.ts` and the historical one-time migration) must therefore
  exclude the retained fields, or retained rows get re-selected every cycle (inflated counts,
  needless rewrites).

## Purge safety gate — do NOT strip ids before the customer name is captured
The internal ids are the ONLY key that can re-fetch a job's customer from ServiceTitan. The
hash `st_job_id_hash` is a fallback recovery key, but the canonical fix is: do not purge the
ids until enrichment has populated a **real** `customerName` (the `Customer <id>` placeholder
counts as not-yet-enriched). `st-data-purge.ts` gates the normal 24h purge on `hasRecoverableName`,
with a **hard 7-day cutoff** that purges regardless so ids never linger indefinitely.
**Why:** stripping ids at 24h before enrichment ran created ~44K unrecoverable-by-id orphan jobs
(blank name/phone/email/address, money + summary + hash only). That is the exact failure mode
of this whole effort — the gate stops it recurring.
**How to apply:** never tighten the purge to fire purely on a time cutoff again; keep it
conditioned on the recoverable name OR the hard bound.

## Purged-row marker (critical gotcha)
A purged row is detected by **`existing.stJobId === null`** — NOT by `customerName === null`.
**Why:** customerName is now retained, so keying the `wasPurged` check off it misclassifies
purged rows as live and the normal update branch rehydrates phone/email/internal ids on the
next ST sync, silently undoing the purge.
**How to apply:** any code in `sync-scheduler.ts` (job sync + backfill) deciding whether to
skip PII repopulation must use the nulled internal id (`stJobId`), since that is the field the
purge actually clears.
