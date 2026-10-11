/**
 * Shared conversational SMS voice (ChatGPT-like thread, not IVR).
 */

export const CONVERSATIONAL_SMS_PRINCIPLES = `
Conversational SMS (like a helpful human on iMessage — not a call center script):
- One turn at a time: react to what they just said, then move the thread forward.
- Use complete but short sentences; contractions; no bullet lists or "Option 1 / Option 2" menus.
- Do not start every message with "Got it", "Perfect", or "Happy to help".
- Do not say SKU, playbook, template, or internal tool names.
- If you need info, ask one natural question — weave it in, don't interrogate.
- Match their tone: casual if they're casual; brief if they're brief.
`.trim();

export function conversationalSlotOfferSms(input: {
  dateLabel: string;
  timeLabels: string[];
  durationPhrase: string;
}): string {
  const { dateLabel, timeLabels, durationPhrase } = input;
  if (timeLabels.length === 0) return `For ${dateLabel} I'm not seeing openings right now — what time of day were you hoping for?`;

  const numbered = timeLabels
    .slice(0, 3)
    .map((label, i) => `${i + 1}) ${label}`)
    .join(", ");

  const dur = durationPhrase.trim();
  const durBit = dur ? ` (${dur.replace(/^for\s+/i, "")})` : "";

  return `For ${dateLabel} I can do ${numbered}${durBit}. Which works — reply 1, 2, or 3, or name a time.`.slice(
    0,
    318
  );
}

export function conversationalOfferClarificationSms(): string {
  return "Which of those times works for you? Reply 1, 2, or 3, or tell me a specific time (like 11:30 AM).";
}

export function conversationalAfterHandoffAck(): string {
  return "Sounds good — someone from the team will text you to finish up. Reach out anytime if plans change.";
}
