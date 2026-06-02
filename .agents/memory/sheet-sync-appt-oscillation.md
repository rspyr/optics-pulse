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
