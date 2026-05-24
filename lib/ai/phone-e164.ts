/** Shared E.164 detector for SMS automation (avoids importing OpenAI-backed modules in Whoosh flows). */
export function isLikelyE164Phone(value: unknown): value is string {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value.trim());
}
