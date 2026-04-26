export const MAP_TO_OPTIONS = [
  "phone", "email", "firstName", "lastName", "fullName",
  "address", "city", "state", "zip",
  "funnel", "appointmentDate", "appointmentTime",
] as const;

export type MapToTarget = typeof MAP_TO_OPTIONS[number];

const MAP_TO_OPTIONS_SET: ReadonlySet<string> = new Set(MAP_TO_OPTIONS);

const HEURISTIC_RULES: ReadonlyArray<{ pattern: RegExp; target: MapToTarget }> = [
  { pattern: /phone|tel/i, target: "phone" },
  { pattern: /email|mail/i, target: "email" },
  { pattern: /zip|postal/i, target: "zip" },
  { pattern: /appt.*date|appointment.*date|booking.*date/i, target: "appointmentDate" },
  { pattern: /appt.*time|appointment.*time|booking.*time/i, target: "appointmentTime" },
  { pattern: /funnel/i, target: "funnel" },
  { pattern: /full.*name/i, target: "fullName" },
  { pattern: /first.*name|fname/i, target: "firstName" },
  { pattern: /last.*name|lname|surname/i, target: "lastName" },
  { pattern: /address|street/i, target: "address" },
  { pattern: /city/i, target: "city" },
  { pattern: /state|province/i, target: "state" },
];

export function normalizeFieldName(fieldName: string): string {
  return fieldName.toLowerCase().replace(/[\s\-\.]/g, "_");
}

export type LearnedSuggestions = ReadonlyMap<string, MapToTarget>;

export function suggestMapTarget(
  fieldName: string,
  learned?: LearnedSuggestions,
): MapToTarget | null {
  if (!fieldName) return null;
  if (learned && learned.size > 0) {
    const learnedHit = learned.get(normalizeFieldName(fieldName));
    if (learnedHit && MAP_TO_OPTIONS_SET.has(learnedHit)) return learnedHit;
  }
  for (const rule of HEURISTIC_RULES) {
    if (rule.pattern.test(fieldName)) return rule.target;
  }
  return null;
}
