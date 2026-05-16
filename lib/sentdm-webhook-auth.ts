import { createHmac, timingSafeEqual } from "crypto";

export type SentdmWebhookVerification =
  | { ok: true }
  | { ok: false; reason: string };

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Validates Sent.dm webhook authenticity. Supports either:
 * - HMAC SHA256 signature in `x-sentdm-signature` (hex), keyed by SENTDM_WEBHOOK_SECRET
 * - Shared secret in `x-sentdm-secret` header equal to SENTDM_WEBHOOK_SECRET
 */
export function verifySentdmWebhookAuthenticity(
  headers: Headers,
  rawBody: string,
  secret = process.env.SENTDM_WEBHOOK_SECRET
): SentdmWebhookVerification {
  if (!secret) {
    return {
      ok: false,
      reason: "SENTDM_WEBHOOK_SECRET is not configured on the server",
    };
  }

  const signatureHeader =
    headers.get("x-sentdm-signature") ??
    headers.get("x-sent-dm-signature");

  if (signatureHeader) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const provided = signatureHeader.replace(/^sha256=/i, "").trim();
    if (timingSafeEqualStrings(expected, provided)) {
      return { ok: true };
    }
    return { ok: false, reason: "Invalid Sent.dm signature" };
  }

  const sharedHeader =
    headers.get("x-sentdm-secret") ?? headers.get("x-sent-dm-secret");
  if (sharedHeader && timingSafeEqualStrings(sharedHeader, secret)) {
    return { ok: true };
  }

  return { ok: false, reason: "Missing Sent.dm signature" };
}
