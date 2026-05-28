const PRE_BOOKED_TRIGGER_VALUES = new Set(["yes", "booked"]);

export function isPreBookedCellValue(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return PRE_BOOKED_TRIGGER_VALUES.has(raw.toLowerCase().trim());
}
