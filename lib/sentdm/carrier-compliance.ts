/**
 * Carrier keyword routing for inbound SMS — STOP / HELP — evaluated before AI generation.
 */

export type CarrierComplianceKind = "stop" | "help";

/** Normalize inbound body for keyword detection (single SMS keyword flows). */
export function normalizeCarrierKeywordMessage(raw: string): string {
  return raw.trim().toLowerCase();
}

/** STOP / unsubscribe-style keywords — persists opt-out when handled upstream. */
export function isCarrierStopKeyword(normalizedText: string): boolean {
  const stopExact = [
    "stop",
    "stop all",
    "unsubscribe",
    "cancel",
    "end",
    "quit",
    "spam",
  ];
  return stopExact.includes(normalizedText);
}

/** HELP / INFO — compliance support copy only (no AI). */
export function isCarrierHelpKeyword(normalizedText: string): boolean {
  return normalizedText === "help" || normalizedText === "info";
}

export function detectCarrierComplianceKind(
  rawText: string
): CarrierComplianceKind | null {
  const n = normalizeCarrierKeywordMessage(rawText);
  if (!n.length) return null;
  if (isCarrierStopKeyword(n)) return "stop";
  if (isCarrierHelpKeyword(n)) return "help";
  return null;
}
