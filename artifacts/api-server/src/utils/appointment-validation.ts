const JUNK_VALUES = new Set([
  "n/a", "na", "none", "tbd", "to be determined",
  "unknown", "pending", "–", "—", "-", ".", "...",
  "not set", "not scheduled", "no", "null", "undefined",
]);

export function isValidAppointmentValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (JUNK_VALUES.has(trimmed.toLowerCase())) return false;
  return true;
}
