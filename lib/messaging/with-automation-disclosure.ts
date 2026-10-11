/**
 * Prepends SMS automation preamble on first outbound (shared by API routes + Sent.dm loop).
 */

export type AutomationDisclosureMode = "minimal" | "full" | "off";

function resolveAutomationDisclosureMode(): AutomationDisclosureMode {
  const raw = (process.env.CLOSEOS_AUTOMATION_DISCLOSURE ?? "minimal")
    .trim()
    .toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0" || raw === "none") {
    return "off";
  }
  if (raw === "full" || raw === "legacy" || raw === "automated") {
    return "full";
  }
  return "minimal";
}

export function withAutomationDisclosure(input: {
  replyText: string;
  assistantName: string;
  businessName: string;
  shouldDiscloseAutomation: boolean;
}) {
  if (!input.shouldDiscloseAutomation) return input.replyText;

  const mode = resolveAutomationDisclosureMode();
  if (mode === "off") return input.replyText;

  const body = input.replyText.trim();
  if (!body) return body;

  if (/\bautomated\b/i.test(body) && mode === "full") return body;

  const assistant = input.assistantName.trim() || input.businessName.trim();
  const business = input.businessName.trim() || "us";

  if (mode === "full") {
    return `Hi, this is ${assistant}, an automated assistant for ${business}. ${body}`;
  }

  // minimal (default): human front-desk framing without "automated assistant"
  if (assistant.toLowerCase() === business.toLowerCase()) {
    return `Hi — ${business} here. ${body}`;
  }
  return `Hi — ${assistant} at ${business}. ${body}`;
}
