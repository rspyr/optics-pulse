export const MAP_TO_OPTIONS = [
  "phone", "email", "firstName", "lastName", "fullName",
  "address", "city", "state", "zip",
  "funnel", "appointmentDate", "appointmentTime",
] as const;

export type MapToTarget = typeof MAP_TO_OPTIONS[number];

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

export function suggestMapTarget(fieldName: string): MapToTarget | null {
  if (!fieldName) return null;
  for (const rule of HEURISTIC_RULES) {
    if (rule.pattern.test(fieldName)) return rule.target;
  }
  return null;
}
