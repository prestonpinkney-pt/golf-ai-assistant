import crypto from "crypto";

/**
 * Square webhook signature verification (HMAC-SHA256 of notification URL + raw body).
 * @see https://developer.squareup.com/docs/webhooks/step3validate
 */
export function verifySquareWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  /** Exact notification URL configured in Square (e.g. https://yourdomain.com/api/webhooks/square) */
  notificationUrl: string;
  signatureKey: string;
}): boolean {
  const { rawBody, signatureHeader, notificationUrl, signatureKey } = input;
  if (!signatureHeader) return false;

  const hmac = crypto.createHmac("sha256", signatureKey);
  hmac.update(notificationUrl + rawBody);
  const digest = hmac.digest("base64");

  try {
    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(signatureHeader, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
