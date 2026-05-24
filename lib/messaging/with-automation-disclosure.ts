/**
 * Prepends mandated SMS automation preamble on first outbound (shared by API routes + Sent.dm loop).
 */

export function withAutomationDisclosure(input: {
  replyText: string;
  assistantName: string;
  businessName: string;
  shouldDiscloseAutomation: boolean;
}) {
  if (!input.shouldDiscloseAutomation) return input.replyText;
  if (/\bautomated\b/i.test(input.replyText)) return input.replyText;

  return `Hi, this is ${input.assistantName}, an automated assistant for ${input.businessName}. ${input.replyText}`;
}
