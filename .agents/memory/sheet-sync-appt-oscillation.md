---
name: Sheet-sync appointment-date oscillation
description: Why a lead's appointmentDate can flip between two values every sync cycle (duplicate phone rows + stale-map compare in rescanExistingRows).
---

# Sheet-sync appointment-date oscillation

When one customer submits the same lead form multiple times, the Google Sheet
accumulates several rows with the **same phone number** but different
`Appointment Date` values. If all those rows sit below the sync watermark they
are all re-processed every cycle by `rescanExistingRows`
(`artifacts/api-server/src/services/sheet-sync.ts`).

`rescanExistingRows` matches sheet rows to leads **by phone only**, loads each
lead's current appt date into an in-memory `leadByPhone` map **once** at the
start, and never refreshes it during the loop. Each row writes the lead only if
`newApptDate !== existingLead.appointmentDate` — compared against that **stale**
snapshot. Net effect: the *last row whose date differs from the cycle's starting
value* wins. Because the starting value alternates each cycle, the winning row
(and thus the stored appt date) **oscillates** between two values on every ~60s
sync, e.g. 6/12 ⇄ 5/18. Intermediate-but-overwritten rows (e.g. an even older
3rd date) are written mid-loop but never observed as the final value.

Symptom in the wild: a lead's `appointment_date` flips between two dates every
cycle; `updated_at` advances one sync interval per flip; **no** call_attempts or
lead_status_history rows (it's purely the sync, not a CSR).

**Why:** rescan has no concept of "most recent submission wins" and compares
against a non-refreshed snapshot.

**How to apply:** when touching sheet-sync rescan logic, dedupe rows by
normalized phone and pick the latest row (by Timestamp / sheet order) as
authoritative before writing; do not write-on-any-difference against a stale
in-memory map. Duplicate-phone rows are expected (repeat ad submissions), so the
matching layer must be idempotent across cycles.

## Resubmission recording: keep the two write paths behaviorally identical

Repeat-phone submissions are recorded as discrete `outcome='resubmission'`
call_attempts entries by TWO paths that must agree on every rule: the live
deferred-sync path (`handleResubmission` in `lead-resubmission.ts`, invoked from
the new-row + rescan paths in `sheet-sync.ts`) and the one-time
`backfillResubmissionTimeline`. Divergence between them is the recurring trap.

Rules both paths must share:
- **Latest-wins ordering** uses one comparator, `rowIsLater(a,b)` (known
  timestamp > unknown; tie-break ascending sheet index). Carry the sheet `index`
  on deferred entries (`OrderedRow`) so the tie-break is identical.
- **Protected states**: `appt_set` or `hasSoldEstimate` lock the appointment
  (record history, never overwrite appt). A `dead` lead may receive booking
  fields but is **never** silently reopened to `appt_booked` — guard the status
  change with `hubStatus !== "appt_booked" && hubStatus !== "dead"` in BOTH paths.

**Backfill idempotency:** dedupe by a source-aware key `(attemptedAt-ms,
apptDate, apptTime)` against existing resubmission rows — NOT a count-based tail
slice (count conflates unrelated CallRail resubmissions and under-backfills). For
rows with no parseable submission timestamp, fall back to `lead.createdAt` so the
key (and the stored `attemptedAt`) reconstruct identically on re-run. Only mutate
the lead / emit when `createdForLead > 0`, else a re-run churns
`updatedAt`/`resubmittedAt` and re-emits. `resubmissionCount` uses SQL
`GREATEST(...)` so it is never lowered.

**Why:** the original bug was write-on-any-diff oscillation; the fix splits work
across live + backfill paths, and any rule that lives in only one path produces
inconsistent terminal states for the same input.
