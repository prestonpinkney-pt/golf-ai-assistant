/** Normalize SMS numbers to E.164 where possible (US-centric). */
export function normalizePhone(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return trimmed;
}
