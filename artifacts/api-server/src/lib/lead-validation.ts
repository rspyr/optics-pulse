export function isValidName(name: string): boolean {
  if (!name || name.trim().length < 2) return false;
  const n = name.trim();
  if (n.length > 60) return false;
  if (/\d/.test(n)) return false;
  if (/[^a-zA-ZÀ-ÖØ-öø-ÿ\s'\-.]/.test(n)) return false;
  if (/(.{1,3})\1{3,}/i.test(n.replace(/\s/g, ""))) return false;
  const letters = n.replace(/[^a-zA-ZÀ-ÖØ-öø-ÿ]/g, "");
  if (letters.length < 2) return false;
  if (!/[a-zA-ZÀ-ÖØ-öø-ÿ]{2,}/.test(n)) return false;
  const words = n.split(/\s+/).filter((w) => /[a-zA-ZÀ-ÖØ-öø-ÿ]/.test(w));
  if (words.length < 2) return false;
  return true;
}

function isSequential(digits: string): boolean {
  if (digits.length < 2) return false;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < digits.length; i++) {
    if (Number(digits[i]) - Number(digits[i - 1]) !== 1) ascending = false;
    if (Number(digits[i - 1]) - Number(digits[i]) !== 1) descending = false;
  }
  return ascending || descending;
}

export function isValidPhone(phone: string): boolean {
  if (!phone || phone.trim().length === 0) return false;
  const digits = phone.replace(/[\s\-()+.]/g, "");
  if (/[^0-9]/.test(digits)) return false;
  if (digits.length === 11 && digits[0] !== "1") return false;
  if (digits.length !== 10 && digits.length !== 11) return false;
  const local = digits.length === 11 ? digits.slice(1) : digits;
  if (local[0] === "0" || local[0] === "1") return false;
  if (local[3] === "0" || local[3] === "1") return false;
  if (/^(\d)\1{9}$/.test(local)) return false;
  const subscriber = local.slice(3);
  if (/^(\d)\1{6}$/.test(subscriber)) return false;
  if (isSequential(subscriber)) return false;
  const counts: Record<string, number> = {};
  for (const d of local) counts[d] = (counts[d] || 0) + 1;
  if (Math.max(...Object.values(counts)) >= 6) return false;
  if (["5555555555", "1234567890", "0987654321", "1111111111"].includes(local)) return false;
  return true;
}

export function getNameValidationError(name: string): string | null {
  if (!name || name.trim().length === 0) return null;
  const n = name.trim();
  if (n.length < 2) return "Name is too short";
  if (/\d/.test(n)) return "Name cannot contain numbers";
  if (/[^a-zA-ZÀ-ÖØ-öø-ÿ\s'\-.]/.test(n)) return "Name contains invalid characters";
  if (/(.{1,3})\1{3,}/i.test(n.replace(/\s/g, ""))) return "Please enter a real name";
  const letters = n.replace(/[^a-zA-ZÀ-ÖØ-öø-ÿ]/g, "");
  if (letters.length < 2) return "Name is too short";
  if (!/[a-zA-ZÀ-ÖØ-öø-ÿ]{2,}/.test(n)) return "Please enter a valid name";
  const words = n.split(/\s+/).filter((w) => /[a-zA-ZÀ-ÖØ-öø-ÿ]/.test(w));
  if (words.length < 2) return "Please enter your first and last name";
  return null;
}

export function getPhoneValidationError(phone: string): string | null {
  if (!phone || phone.trim().length === 0) return null;
  const digits = phone.replace(/[\s\-()+.]/g, "");
  if (digits.length === 0) return null;
  if (/[^0-9]/.test(digits)) return "Phone number can only contain digits";
  if (digits.length < 10) return "Please enter a full 10-digit phone number";
  if (digits.length === 11 && digits[0] !== "1") return "Invalid country code";
  if (digits.length > 11) return "Phone number is too long";
  const local = digits.length === 11 ? digits.slice(1) : digits;
  if (local[0] === "0" || local[0] === "1") return "Invalid area code";
  if (local[3] === "0" || local[3] === "1") return "Invalid phone number";
  if (/^(\d)\1{9}$/.test(local)) return "Please enter a real phone number";
  const subscriber = local.slice(3);
  if (/^(\d)\1{6}$/.test(subscriber)) return "Please enter a real phone number";
  if (isSequential(subscriber)) return "Please enter a real phone number";
  const counts: Record<string, number> = {};
  for (const d of local) counts[d] = (counts[d] || 0) + 1;
  if (Math.max(...Object.values(counts)) >= 6) return "Please enter a real phone number";
  if (["5555555555", "1234567890", "0987654321", "1111111111"].includes(local)) return "Please enter a real phone number";
  return null;
}

function normalizedName(parts: { firstName?: string | null; lastName?: string | null; fullName?: string | null }): string {
  const raw = parts.fullName?.trim() || [parts.firstName, parts.lastName].filter(Boolean).join(" ");
  return raw.toLowerCase().replace(/[^a-zÀ-ÖØ-öø-ÿ\s'\-.]/gi, " ").replace(/\s+/g, " ").trim();
}

const BLOCKED_NAMES = new Set(["john doe", "jane doe", "fsgsfd gfds"]);

export function getLeadSpamReason(input: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  phone?: string | null;
}): string | null {
  const name = normalizedName(input);
  const phone = input.phone?.trim() ?? "";
  const hasPhone = phone.length > 0;
  const phoneValid = hasPhone ? isValidPhone(phone) : false;

  if (BLOCKED_NAMES.has(name)) return `Known junk name: ${name}`;
  if (name === "unknown" && !phoneValid) return "Unknown name with no valid phone number";
  if (name && !isValidName(name) && !phoneValid) return "Invalid name and no valid phone number";
  if (!name && !phoneValid) return "Missing customer name and valid phone number";
  return null;
}
