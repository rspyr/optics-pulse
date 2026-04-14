const TZ_QUALIFIED = /(?:Z|[+-]\d{2}:\d{2}|[+-]\d{4})$/;

function getTimezoneOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value || "0");

  const hour = get("hour") === 24 ? 0 : get("hour");
  const localAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return localAsUtc - date.getTime();
}

export function parseDateInTimezone(
  dateStr: string,
  tz: string,
): Date | undefined {
  const trimmed = dateStr.trim();
  const naive = new Date(trimmed);
  if (isNaN(naive.getTime())) return undefined;

  if (TZ_QUALIFIED.test(trimmed)) {
    return naive;
  }

  const offsetMs = getTimezoneOffsetMs(naive, tz);
  const adjusted = new Date(naive.getTime() - offsetMs);

  const offsetMs2 = getTimezoneOffsetMs(adjusted, tz);
  if (offsetMs2 !== offsetMs) {
    return new Date(naive.getTime() - offsetMs2);
  }
  return adjusted;
}
