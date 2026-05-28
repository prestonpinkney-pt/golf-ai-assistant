import OpenAI from "openai";
import { AI_AUTO_SEND_POLICY } from "@/app/api/config/ai-source-of-truth";

import { isLikelyE164Phone } from "@/lib/ai/phone-e164";

export { isLikelyE164Phone };

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey?.trim()) {
      throw new Error("Missing OPENAI_API_KEY");
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

export const AI_RESPONSE_MODEL = "gpt-4o-mini";
export const PENDING_SEND_STATUS = "pending_send";

export const DEFAULT_ESCALATION_REPLY =
  "Got it — I'm going to have the team look at this directly so we don't give you the wrong answer.";

export type ConversationHistoryMessage = {
  direction: string | null;
  channel: string | null;
  message_text: string | null;
  status: string | null;
  created_at: string | null;
};

export type RiskLevel = "low" | "medium" | "high";

export type AiResponseDecision = {
  intent: string;
  confidence: number;
  risk_level: RiskLevel;
  can_auto_send: boolean;
  escalation_required: boolean;
  escalation_reason: string | null;
  reply_text: string;
};

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function decidePlaybook(message: string): string {
  const text = (message || "").toLowerCase();

  if (
    text.includes("simulator") ||
    text.includes("sim bay") ||
    text.includes("bay time") ||
    text.includes("trackman") ||
    text.includes("foresight") ||
    text.includes(" gcquad") ||
    text.includes("gc quad") ||
    text.includes("bay booking") ||
    (text.includes(" sim ") && !text.includes("similar")) ||
    /\bsim\b/.test(text)
  ) {
    return "simulator";
  }

  if (
    text.includes("lesson") ||
    text.includes("swing") ||
    text.includes("junior") ||
    text.includes("30 min") ||
    text.includes("1 hour")
  ) {
    return "lesson";
  }

  if (
    text.includes("event") ||
    text.includes("party") ||
    text.includes("birthday") ||
    text.includes("corporate") ||
    text.includes("group")
  ) {
    return "event";
  }

  if (
    text.includes("membership") ||
    text.includes("member") ||
    text.includes("monthly")
  ) {
    return "membership";
  }

  return "general";
}

export function formatConversationHistory(messages: ConversationHistoryMessage[]) {
  if (messages.length === 0) return "No prior conversation history.";

  return messages
    .map((message) => {
      const direction = message.direction || "unknown";
      const channel = message.channel || "unknown";
      const text = message.message_text?.trim() || "(empty message)";
      return `${direction} via ${channel}: ${text}`;
    })
    .join("\n");
}

export async function generateAiDecision(input: {
  inboundText: string;
  playbook: string;
  currentState: string;
  contactName?: string | null;
  channel?: string | null;
  businessName: string;
  assistantName: string;
  shouldDiscloseAutomation: boolean;
  sourceOfTruth: string;
  conversationHistory: ConversationHistoryMessage[];
  /** Runtime SMS booking / concierge notes merged into prompt (Whoosh appendix, escalations). */
  runtimeAppendix?: string | null;
}): Promise<AiResponseDecision> {
  const completion = await getOpenAI().chat.completions.create({
    model: AI_RESPONSE_MODEL,
    temperature: 0.52,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
You are ${input.businessName}'s SMS assistant — a sharp, calm front desk for a golf business (${input.assistantName}). You are not generic SaaS support.

Personality: helpful and clear first (~85%), a little golf personality or wit only when the customer sounds normal and upbeat (~10%), gentle confident direction toward a booking when it fits (~5%). Wit examples when appropriate: "Let's get that swing some reps," "We can keep the rust off the clubs," "Good call — a little structured practice goes a long way," "Let's make that next round less stressful." Never force jokes, puns, sarcasm, or wit if they sound upset, confused, or are on refunds/pricing beef.

Use ONLY this source of truth plus any facts already in conversation history:
${input.sourceOfTruth}

Reply style:
- SMS-native: contractions, short sentences, aim under ~320 characters when you can.
- At most ONE question mark total when you need info (one question per message).
- Do not sound scripted. Avoid "happy to help," "Absolutely," "I'd be delighted," "as an AI," "Great question," and fake hype.
- Do not include URLs, links, or "click here" in reply_text.
- If the customer sends a link: do not claim you opened it; say you can't open links in SMS and ask what they need in plain text.
- If First automated reply requiring disclosure is yes, write reply_text as the body only — do not say you are automated; the system prepends a required disclosure line.
- Use history for vague replies ("yes", "that", "Friday").

Sales + qualification (playbook hint: use Detected playbook from the user message as bias, not a script):
- Lessons: adult vs junior → 30 vs 60 min → day/time → soft close.
- Simulator: # players → practice vs 9 vs 18 vs hourly → day/time → soft close.
- Membership: how often they visit → suggest tier at high level → invite next step (staff can detail).
- Events: headcount → date/time → duration + F&B.
- Booking-ready customer: lean into locking a time; still never claim booked unless history/source says so.
- Vague: offer clear choices, e.g. "Got you — lesson, simulator, membership, or event?"

Before you finalize reply_text, mentally verify: (1) natural text thread, (2) concise, (3) at most one question, (4) moves toward a useful next step when appropriate, (5) tone matches the mix above, (6) no robotic filler, (7) no overpromising.

Risk and JSON:
- risk_level "low" only for straightforward, low-stakes scheduling or info requests you can answer from source/history without promising specifics you don't have.
- risk_level "medium" or "high" + escalation_required true for refunds, disputes, anger, legal/safety, money complaints, custom pricing/discount demands, or anything requiring facts not in source/history. Use reply_text: "Got it — I'm going to have the team look at this directly so we don't give you the wrong answer." (or equivalent) for those handoffs.
- can_auto_send true only when you would personally send this without human review: low stakes, no invented facts, no forbidden claims.

Hard rules:
- Never invent price, availability, calendar checks, instructor names, policies, refunds, or guarantees.
- Never say a booking is confirmed or that you booked them unless source/history explicitly confirms the system did it.

Reference reply shapes (adapt to real names and facts; do not copy blindly if context differs):
- Lesson: "Got you. Is this for an adult lesson or a junior lesson?"
- After adult: "Perfect. Are you thinking 30 minutes or a full hour?"
- Membership: "Depends how often you want to play. Are you thinking a couple times a month, weekly, or more than that?"
- Simulator: "For sure. How many players are you bringing?"
- Event: "Absolutely. About how many people are you expecting?"
- Price objection: stay calm; one question on whether they want lowest cost vs best improvement path — only if that fits offerings in source of truth.
- Angry / refund: handoff line, high risk, no wit.
- "What times do you have?" / availability without live Whoosh options in Runtime context: probe day + morning/afternoon/evening preference only — NEVER list hypothetical hours like “10 AM, 1 PM, 5 PM” unless those exact localized times appear verbatim in Runtime context JSON or prior assistant messages.
- "How much?" / price before intent is clear: "Depends what you're looking for — simulator time, a lesson, or membership?" (tweak wording to sound natural).
- "I'm interested" / vague positive: "Good deal — you thinking practice, playing 9, or a lesson?"
- Specific day ("Can I come Friday?"): "For sure — how many players would you have?" (unless they already said; still do not confirm the slot without data).
- Greetings ("hello", "hi", "hey", "what's up" with no other context): intent "greeting", confidence 0.75, risk "low", can_auto_send true, reply with a friendly prompt offering 2-3 clear choices (e.g. "Hey! Looking to book a simulator, grab a lesson, or something else?").

If you cannot understand the request, intent "unknown", risk "high", can_auto_send false, escalation_required true, reply_text a short polite handoff.

confidence is a float 0.0–1.0. Use 0.65–0.95 for messages you clearly understand and can handle from the source of truth. Reserve < 0.40 for truly ambiguous or out-of-scope requests only.

Return only JSON:
{
  "intent": "short_intent_label",
  "confidence": 0.85,
  "risk_level": "low" | "medium" | "high",
  "can_auto_send": true,
  "escalation_required": false,
  "escalation_reason": null,
  "reply_text": "customer-facing SMS text"
}
        `.trim(),
      },
      {
        role: "user",
        content: `
Business: ${input.businessName}
Assistant name: ${input.assistantName}
Contact name: ${input.contactName?.trim() || "Unknown"}
Channel: ${input.channel || "sms"}
Conversation state: ${input.currentState}
First automated reply requiring disclosure: ${input.shouldDiscloseAutomation ? "yes" : "no"}
Detected playbook: ${input.playbook}
Conversation history:
${formatConversationHistory(input.conversationHistory)}

${typeof input.runtimeAppendix === "string" && input.runtimeAppendix.trim() ? `\nRuntime context:\n${input.runtimeAppendix.trim()}\n` : ""}

Customer message: ${input.inboundText}
        `.trim(),
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim();
  if (!raw) {
    throw new Error("OpenAI returned an empty response");
  }

  return normalizeAiDecision(JSON.parse(raw));
}

function includesAnyTerm(text: string, terms: readonly string[]) {
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}

export function getMetadataString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export { withAutomationDisclosure } from "@/lib/messaging/with-automation-disclosure";

export function normalizeAiDecision(value: unknown): AiResponseDecision {
  const parsed = (value ?? {}) as Partial<AiResponseDecision>;
  const riskLevel: RiskLevel =
    parsed.risk_level === "low" ||
    parsed.risk_level === "medium" ||
    parsed.risk_level === "high"
      ? parsed.risk_level
      : "high";
  const confidence = Number(parsed.confidence);
  const boundedConfidence = Number.isFinite(confidence)
    ? Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence))
    : 0;
  const replyText =
    typeof parsed.reply_text === "string" && parsed.reply_text.trim()
      ? parsed.reply_text.trim()
      : DEFAULT_ESCALATION_REPLY;
  const escalationRequired =
    parsed.escalation_required === true || riskLevel !== "low";

  return {
    intent:
      typeof parsed.intent === "string" && parsed.intent.trim()
        ? parsed.intent.trim()
        : "unknown",
    confidence: boundedConfidence,
    risk_level: riskLevel,
    can_auto_send: parsed.can_auto_send === true,
    escalation_required: escalationRequired,
    escalation_reason:
      typeof parsed.escalation_reason === "string" && parsed.escalation_reason.trim()
        ? parsed.escalation_reason.trim()
        : escalationRequired
          ? "AI marked this message for human review."
          : null,
    reply_text: replyText,
  };
}

export function buildFallbackDecision(reason: string): AiResponseDecision {
  return {
    intent: "unknown",
    confidence: 0,
    risk_level: "high",
    can_auto_send: false,
    escalation_required: true,
    escalation_reason: reason,
    reply_text: DEFAULT_ESCALATION_REPLY,
  };
}

const UNKNOWN_INTENT = "unknown";

/**
 * When the model is unsure, force Apple-style handoff copy and block auto-send.
 */
export function applyMisunderstoodRouting(
  decision: AiResponseDecision,
  businessName: string,
  confidenceFloor = 0.42
): AiResponseDecision {
  const intentLower = decision.intent.trim().toLowerCase();
  const isUnknownIntent = intentLower === UNKNOWN_INTENT;
  const lowConfidence = decision.confidence < confidenceFloor;

  if (!isUnknownIntent && !lowConfidence) {
    return decision;
  }

  const routing = `Got it — I'm looping in someone from ${businessName.trim()} so we don't steer you wrong. They'll follow up directly.`;

  return {
    ...decision,
    intent: isUnknownIntent ? UNKNOWN_INTENT : decision.intent,
    reply_text: routing,
    escalation_required: true,
    can_auto_send: false,
    risk_level: "high",
    escalation_reason:
      decision.escalation_reason?.trim() ||
      (isUnknownIntent
        ? "Assistant could not determine customer intent."
        : "Assistant confidence was below the safe threshold for automation."),
  };
}

export function getAutoSendDecision(input: {
  inboundText: string;
  decision: AiResponseDecision;
  channel?: string | null;
  phone?: unknown;
  /** When true, skip substring checks against riskyResponseTerms (e.g. vetted deterministic Whoosh confirmations). */
  bypassRiskyResponseTerms?: boolean;
  policy?: {
    enabled: boolean;
    minConfidence: number;
    maxSmsLength: number;
    riskyInboundTerms?: readonly string[];
    riskyResponseTerms?: readonly string[];
  };
}): { shouldAutoSend: boolean; reason: string } {
  const policy = input.policy ?? AI_AUTO_SEND_POLICY;
  const inboundTerms = policy.riskyInboundTerms ?? AI_AUTO_SEND_POLICY.riskyInboundTerms;
  const responseTerms = policy.riskyResponseTerms ?? AI_AUTO_SEND_POLICY.riskyResponseTerms;

  if (!policy.enabled) {
    return { shouldAutoSend: false, reason: "auto_send_disabled" };
  }

  if (input.channel !== "sms") {
    return { shouldAutoSend: false, reason: "not_sms_channel" };
  }

  if (!isLikelyE164Phone(input.phone)) {
    return { shouldAutoSend: false, reason: "missing_valid_phone" };
  }

  if (input.decision.escalation_required) {
    return { shouldAutoSend: false, reason: "ai_escalation_required" };
  }

  if (!input.decision.can_auto_send) {
    return { shouldAutoSend: false, reason: "ai_auto_send_denied" };
  }

  if (input.decision.confidence < policy.minConfidence) {
    return { shouldAutoSend: false, reason: "low_ai_confidence" };
  }

  if (input.decision.risk_level !== "low") {
    return { shouldAutoSend: false, reason: "non_low_risk_level" };
  }

  if (input.decision.reply_text.length > policy.maxSmsLength) {
    return { shouldAutoSend: false, reason: "response_too_long" };
  }

  if (includesAnyTerm(input.inboundText, inboundTerms)) {
    return { shouldAutoSend: false, reason: "risky_inbound_topic" };
  }

  if (!input.bypassRiskyResponseTerms && includesAnyTerm(input.decision.reply_text, responseTerms)) {
    return { shouldAutoSend: false, reason: "risky_response_claim" };
  }

  return { shouldAutoSend: true, reason: "low_risk_sms_reply" };
}

export function getNextConversationState(
  currentState: string,
  playbook: string,
  inboundText: string
): string {
  const text = (inboundText || "").toLowerCase();

  if (currentState === "new_inquiry") {
    return "qualifying";
  }

  if (currentState === "qualifying") {
    if (
      playbook === "lesson" &&
      (text.includes("30") ||
        text.includes("1 hour") ||
        text.includes("hour") ||
        text.includes("this week") ||
        text.includes("book"))
    ) {
      return "ready_to_book";
    }

    if (
      playbook === "simulator" &&
      (text.includes("player") ||
        text.includes("players") ||
        text.includes("9") ||
        text.includes("18") ||
        text.includes("practice") ||
        text.includes("friday") ||
        text.includes("saturday") ||
        text.includes("sunday") ||
        text.includes("book"))
    ) {
      return "ready_to_book";
    }

    if (
      playbook === "event" &&
      (text.includes("birthday") ||
        text.includes("corporate") ||
        text.includes("party") ||
        text.includes("people") ||
        text.includes("date"))
    ) {
      return "ready_to_book";
    }

    if (
      playbook === "membership" &&
      (text.includes("membership") ||
        text.includes("practice") ||
        text.includes("play") ||
        text.includes("weekly"))
    ) {
      return "ready_to_book";
    }
  }

  return currentState;
}
