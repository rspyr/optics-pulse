export const APPOINTMENT_JUNK_VALUES = [
  "n/a", "na", "none", "tbd", "to be determined",
  "unknown", "pending", "–", "—", "-", ".", "...",
  "not set", "not scheduled", "no", "null", "undefined",
] as const;

const JUNK_SET = new Set<string>(APPOINTMENT_JUNK_VALUES);

export function isValidAppointmentValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (JUNK_SET.has(trimmed.toLowerCase())) return false;
  return true;
}
