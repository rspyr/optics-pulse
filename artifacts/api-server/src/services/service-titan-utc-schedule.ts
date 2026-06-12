export const SERVICE_TITAN_SCHEDULE_INTERVAL_MINUTES = 15;
export const DEFAULT_ST_JOBS_SYNC_UTC_MINUTE_OFFSET = 0;
export const DEFAULT_ST_REVENUE_SYNC_UTC_MINUTE_OFFSET = 5;
export const SERVICE_TITAN_UTC_SCHEDULER_VERSION = "service-titan-utc-v1";

export type ScheduledServiceTitanSyncType = "jobs" | "revenue";

export function normalizeServiceTitanUtcMinuteOffset(value: unknown, fallback: number): number {
  const normalizedFallback = Number.isInteger(fallback) && fallback >= 0 && fallback < SERVICE_TITAN_SCHEDULE_INTERVAL_MINUTES
    ? fallback
    : 0;
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < SERVICE_TITAN_SCHEDULE_INTERVAL_MINUTES
    ? Number(value)
    : normalizedFallback;
}

export function getServiceTitanUtcScheduleLabels(offset: number): string[] {
  const normalized = normalizeServiceTitanUtcMinuteOffset(offset, DEFAULT_ST_JOBS_SYNC_UTC_MINUTE_OFFSET);
  return Array.from({ length: 4 }, (_, idx) => `:${String(normalized + idx * SERVICE_TITAN_SCHEDULE_INTERVAL_MINUTES).padStart(2, "0")}`);
}

export function getNextServiceTitanScheduledAt(offset: number, from: Date = new Date()): Date {
  const normalized = normalizeServiceTitanUtcMinuteOffset(offset, DEFAULT_ST_JOBS_SYNC_UTC_MINUTE_OFFSET);
  const next = new Date(from.getTime());
  next.setUTCSeconds(0, 0);
  if (from.getUTCSeconds() > 0 || from.getUTCMilliseconds() > 0) {
    next.setUTCMinutes(next.getUTCMinutes() + 1);
  }
  for (let i = 0; i <= SERVICE_TITAN_SCHEDULE_INTERVAL_MINUTES; i++) {
    if (next.getUTCMinutes() % SERVICE_TITAN_SCHEDULE_INTERVAL_MINUTES === normalized) {
      return next;
    }
    next.setUTCMinutes(next.getUTCMinutes() + 1);
  }
  return next;
}

export function getUtcMinuteSlot(now: Date): Date {
  const slot = new Date(now.getTime());
  slot.setUTCSeconds(0, 0);
  return slot;
}

export function serviceTitanOffsetDueAt(offset: number, scheduledForUtc: Date): boolean {
  return scheduledForUtc.getUTCMinutes() % SERVICE_TITAN_SCHEDULE_INTERVAL_MINUTES === offset;
}

export function buildScheduledServiceTitanMetadata(
  syncType: ScheduledServiceTitanSyncType,
  scheduledForUtc: Date,
  minuteOffset: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    scheduler: SERVICE_TITAN_UTC_SCHEDULER_VERSION,
    scheduleType: syncType,
    intervalMinutes: SERVICE_TITAN_SCHEDULE_INTERVAL_MINUTES,
    utcMinuteOffset: minuteOffset,
    scheduledForUtc: scheduledForUtc.toISOString(),
    ...extra,
  };
}
