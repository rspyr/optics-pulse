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
      const serialised = JSON.stringify(value);
      // JSON.stringify can return undefined when the value (or its toJSON())
      // is itself undefined / a function — fall back to (no value) so the row
      // never silently renders blank.
      return serialised ?? "(no value)";
    } catch {
      return "(unserialisable)";
    }
  }
  return String(value);
}
