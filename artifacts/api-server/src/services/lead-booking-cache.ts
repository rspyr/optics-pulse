/**
 * Shared helper for resetting the denormalized booking cache on a lead row
 * whenever a code path transitions the lead OUT of a booked/sold state.
 *
 * Why this exists
 * ---------------
 * `getBookingStatsByIdsAndDate` (coordinator-stats) joins on
 * `leadsTable.status IN ('booked', 'sold')` and scopes per-CSR via
 * `leadsTable.bookedByCsrId`. If `disposition` / `bookedByCsrId` /
 * `bookedAt` are not cleared on un-book, the lead can:
 *   - keep stale per-CSR attribution if `status` is later flipped back into
 *     {booked, sold} via another path that doesn't re-stamp `bookedByCsrId`,
 *   - leak into the booking aggregate via a future status flip that doesn't
 *     reset `disposition` either.
 *
 * Tasks #426, #429, and #431 each plugged a different one of these leaks
 * with the same four-line block. This helper unifies them so future
 * un-book paths can't drift.
 *
 * What it does
 * ------------
 * If the lead is currently in `booked` or `sold`, sets
 * `disposition`, `bookedByCsrId`, and `bookedAt` to `null` on the provided
 * updates object. Callers remain responsible for setting `status` /
 * `hubStatus` to the appropriate new value — different un-book paths land
 * on different terminal statuses (e.g. `dead` → `lost`, `call_back` →
 * `contacted`, day-aging → `new` / `contacted`).
 */
export function resetBookingCache(
  updates: Record<string, unknown>,
  lead: { status: string },
): void {
  if (lead.status === "booked" || lead.status === "sold") {
    updates.disposition = null;
    updates.bookedByCsrId = null;
    updates.bookedAt = null;
  }
}
