import crypto from "crypto";

export function verifyCallRailSignature(
  payload: string,
  signature: string | undefined,
  signingKey: string | undefined,
): boolean {
  if (!signingKey) {
    if (process.env.NODE_ENV === "development") {
      console.warn("[CallRail] No signing key configured, skipping verification in dev mode");
      return true;
    }
    return false;
  }

  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", signingKey)
    .update(payload)
    .digest("hex");

  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
