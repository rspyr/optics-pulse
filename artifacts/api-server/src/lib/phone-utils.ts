import crypto from "crypto";

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits;
}

export function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export function hashPhone(phone: string): string {
  return hashValue(normalizePhone(phone));
}

export function hashEmail(email: string): string {
  return hashValue(email);
}
