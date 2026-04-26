export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "(no value)";
  if (typeof value === "string") {
    return value === "" ? "(empty)" : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "(unserialisable)";
    }
  }
  return String(value);
}
