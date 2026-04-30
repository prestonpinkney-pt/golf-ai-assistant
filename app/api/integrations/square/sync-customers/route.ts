import { createClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { gateBusinessUserOrCron } from "../../../lib/require-auth";
import { decryptToken } from "@/lib/square-token-crypto";
import { BUSINESS_ID } from "../../../config";

const PRIMETIME_GOLF_BUSINESS_ID = BUSINESS_ID;
const SQUARE_VERSION = "2025-01-23";

type SquareMoney = {
  amount?: number;
  currency?: string;
};

type SquarePayment = {
  id: string;
  status: string;
  created_at: string;
  amount_money?: SquareMoney;
  buyer_email_address?: string;
  order_id?: string;
  customer_id?: string;
};

type SquareOrder = {
  id: string;
  customer_id?: string;
  line_items?: Array<{
    name?: string;
    quantity?: string;
    total_money?: SquareMoney;
    variation_name?: string;
  }>;
};
type SquareCustomer = {
  id: string;
  given_name?: string;
  family_name?: string;
  email_address?: string;
  phone_number?: string;
};
type SquareConnection = {
  access_token_encrypted: string;
  location_id: string | null;
  revoked_at: string | null;
};

type BusinessProfile = {
  business_name: string;
  brand_voice: string | null;
  sales_goal_cents: number;
  primary_revenue_streams: string[];
  ideal_customer_types: string[];
  ai_notes: string | null;
};

type RevenuePlaybook = {
  playbook_key: string;
  name: string;
  opportunity_type: string;
  target_conditions: {
    signals?: string[];
    exclude?: string[];
  };
  offer_description: string;
  estimated_value_cents: number;
  message_guidelines: string | null;
};

type PlaybookMessageFramework = {
  playbook_key: string;
  goal: string;
  message_angle: string;
  primary_cta: string;
  tone_rules: string;
  avoid_rules: string[];
  example_messages: string[];
};

type CustomerProfileLookup = {
  id: string;
  external_customer_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  is_member: boolean;
  exclude_from_ai_targeting: boolean;
};

type PurchaseStatRow = {
  external_customer_id: string;
  amount_cents: number;
  occurred_at: string;
  purchase_category: string;
  opportunity_type: string | null;
  detected_intent: string | null;
};

type PurchaseClassification = {
  category: string;
  opportunityType: string;
  intent: string;
  signals: string[];
};

type RecognizedOpportunity = {
  key: string;
  opportunityType: string;
  requiredPlaybookKey: string;
  signalSummary: string;
  nextBestAction: string;
  replyHandlingGoal: string;
  baseConfidenceBoost: number;
};

type AiFeedbackRow = {
  customer_profile_id: string | null;
  targeting_profile_id: string | null;
  feedback_type: string;
  playbook: string | null;
  opportunity_type: string | null;
  previous_score: number | null;
  previous_confidence: number | null;
  should_exclude: boolean | null;
  should_mark_member: boolean | null;
  converted_revenue_cents: number | null;
  created_at: string;
};

type FeedbackSummary = {
  goodTargetCount: number;
  wrongOfferCount: number;
  convertedCount: number;
  notInterestedCount: number;
  badDataCount: number;
  excludeCount: number;
  shouldMarkMember: boolean;
  shouldExclude: boolean;
  convertedRevenueCents: number;
  wrongOfferPlaybooks: Set<string>;
  convertedPlaybooks: Set<string>;
  latestFeedbackAt: string | null;
};

type TargetingWriteRow = {
  business_id: string;
  customer_profile_id: string;
  target_score: number;
  recommended_playbook: string;
  recommended_offer: string;
  reason: string;
  opportunity_type: string;
  estimated_revenue_cents: number;
  confidence: number;
  recommended_message: string;
  recognized_opportunity: string;
  opportunity_signal_summary: string;
  next_best_action: string;
  reply_handling_goal: string;
  last_evaluated_at: string;
};

type AiOpportunityWriteRow = {
  business_id: string;
  customer_profile_id: string;
  targeting_profile_id: string | null;
  recognized_opportunity: string;
  opportunity_type: string;
  playbook: string;
  status: "open";
  priority: number;
  confidence: number;
  estimated_revenue_cents: number;
  signal_summary: string;
  next_best_action: string;
  reply_handling_goal: string;
  recommended_message: string;
  source: "closeos";
  last_evaluated_at: string;
  updated_at: string;
};

const MEMBERSHIP_ITEM_NAMES = [
  "primetime associate",
  "primetime peak access",
  "primetime quarter",
];

function getSquareApiBaseUrl() {
  return process.env.SQUARE_ENVIRONMENT === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
    },
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function squareFetch<T>(
  path: string,
  accessToken: string,
  init?: RequestInit
): Promise<T> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`${getSquareApiBaseUrl()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Square-Version": SQUARE_VERSION,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const text = await response.text();

    if (response.ok) {
      return text ? (JSON.parse(text) as T) : ({} as T);
    }

    const isRateLimited =
      response.status === 429 || text.includes("RATE_LIMITED");

    if (isRateLimited && attempt < maxAttempts) {
      await sleep(1500 * attempt);
      continue;
    }

    throw new Error(`Square request failed for ${path}: ${text}`);
  }

  throw new Error(`Square request failed for ${path}`);
}

function getBackfillRange(days = 30) {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - days);

  return {
    beginTime: start.toISOString(),
    endTime: now.toISOString(),
  };
}

function cleanMessage(message: string) {
  return message
    .replaceAll("Hi —", "Hi,")
    .replaceAll("Hi -", "Hi,")
    .replaceAll("Hi—", "Hi,")
    .replaceAll("Hi–", "Hi,")
    .replaceAll("Hello —", "Hello,")
    .replaceAll("Hello -", "Hello,")
    .replaceAll("Hey —", "Hey,")
    .replaceAll("Hey -", "Hey,")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMembershipItem(text: string) {
  return MEMBERSHIP_ITEM_NAMES.some((itemName) => text.includes(itemName));
}

function classifyPurchase(itemNames: string[]): PurchaseClassification {
  const text = itemNames.join(" ").toLowerCase();

  if (
    hasMembershipItem(text) ||
    text.includes("membership") ||
    text.includes("member") ||
    text.includes("monthly")
  ) {
    return {
      category: "membership",
      opportunityType: "membership",
      intent: "membership_activity",
      signals: ["membership", "member"],
    };
  }

  if (
    text.includes("lesson") ||
    text.includes("instruction") ||
    text.includes("coaching")
  ) {
    return {
      category: "lesson",
      opportunityType: "lesson",
      intent: "instruction_interest",
      signals: ["lesson", "instruction", "coaching"],
    };
  }

  if (
    text.includes("simulator") ||
    text.includes("bay") ||
    text.includes("trackman") ||
    text.includes("practice")
  ) {
    return {
      category: "simulator",
      opportunityType: "lesson",
      intent: "practice_activity",
      signals: ["simulator", "practice"],
    };
  }

  if (
    text.includes("clinic") ||
    text.includes("junior") ||
    text.includes("camp")
  ) {
    return {
      category: "clinic",
      opportunityType: "event",
      intent: "program_interest",
      signals: ["clinic", "junior", "camp"],
    };
  }

  if (
    text.includes("event") ||
    text.includes("outing") ||
    text.includes("party") ||
    text.includes("corporate")
  ) {
    return {
      category: "event",
      opportunityType: "event",
      intent: "group_event_interest",
      signals: ["event", "outing", "corporate"],
    };
  }

  if (
    text.includes("tee") ||
    text.includes("green fee") ||
    text.includes("round")
  ) {
    return {
      category: "tee_time",
      opportunityType: "membership",
      intent: "repeat_play",
      signals: ["tee_time", "round", "repeat_visits"],
    };
  }

  if (
    text.includes("hat") ||
    text.includes("shirt") ||
    text.includes("glove") ||
    text.includes("ball") ||
    text.includes("retail")
  ) {
    return {
      category: "retail",
      opportunityType: "reactivation",
      intent: "retail_purchase",
      signals: ["retail", "past_purchase"],
    };
  }

  return {
    category: "unknown",
    opportunityType: "reactivation",
    intent: "purchase_activity",
    signals: ["past_purchase"],
  };
}

function emptyFeedbackSummary(): FeedbackSummary {
  return {
    goodTargetCount: 0,
    wrongOfferCount: 0,
    convertedCount: 0,
    notInterestedCount: 0,
    badDataCount: 0,
    excludeCount: 0,
    shouldMarkMember: false,
    shouldExclude: false,
    convertedRevenueCents: 0,
    wrongOfferPlaybooks: new Set<string>(),
    convertedPlaybooks: new Set<string>(),
    latestFeedbackAt: null,
  };
}

function summarizeFeedback(rows: AiFeedbackRow[]) {
  const feedbackByCustomerProfileId = new Map<string, FeedbackSummary>();

  for (const row of rows) {
    if (!row.customer_profile_id) continue;

    const summary =
      feedbackByCustomerProfileId.get(row.customer_profile_id) ??
      emptyFeedbackSummary();

    if (row.feedback_type === "good_target") {
      summary.goodTargetCount += 1;
    }

    if (row.feedback_type === "wrong_offer") {
      summary.wrongOfferCount += 1;

      if (row.playbook) {
        summary.wrongOfferPlaybooks.add(row.playbook);
      }
    }

    if (row.feedback_type === "converted") {
      summary.convertedCount += 1;
      summary.convertedRevenueCents += row.converted_revenue_cents ?? 0;

      if (row.playbook) {
        summary.convertedPlaybooks.add(row.playbook);
      }
    }

    if (row.feedback_type === "not_interested") {
      summary.notInterestedCount += 1;
    }

    if (row.feedback_type === "bad_data") {
      summary.badDataCount += 1;
    }

    if (row.feedback_type === "exclude") {
      summary.excludeCount += 1;
    }

    if (row.should_mark_member) {
      summary.shouldMarkMember = true;
    }

    if (row.should_exclude) {
      summary.shouldExclude = true;
    }

    if (
      !summary.latestFeedbackAt ||
      new Date(row.created_at) > new Date(summary.latestFeedbackAt)
    ) {
      summary.latestFeedbackAt = row.created_at;
    }

    feedbackByCustomerProfileId.set(row.customer_profile_id, summary);
  }

  return feedbackByCustomerProfileId;
}

function recognizeOpportunity(input: {
  categories: string[];
  intents: string[];
  signals: string[];
  visitCount: number;
  totalSpendCents: number;
  lastPurchaseAt: string | null;
  isMember: boolean;
}) {
  const categories = new Set(input.categories);
  const intents = new Set(input.intents);
  const signals = new Set(input.signals);

  const lastPurchaseAt = input.lastPurchaseAt
    ? new Date(input.lastPurchaseAt)
    : null;

  const daysSincePurchase = lastPurchaseAt
    ? Math.floor((Date.now() - lastPurchaseAt.getTime()) / 86400000)
    : null;

  const hasEventIntent =
    categories.has("event") ||
    intents.has("group_event_interest") ||
    signals.has("outing") ||
    signals.has("corporate");

  const hasPracticeOrLessonIntent =
    categories.has("simulator") ||
    categories.has("lesson") ||
    intents.has("practice_activity") ||
    intents.has("instruction_interest") ||
    signals.has("lesson") ||
    signals.has("instruction") ||
    signals.has("coaching") ||
    signals.has("practice") ||
    signals.has("simulator");

  const hasClinicIntent =
    categories.has("clinic") ||
    intents.has("program_interest") ||
    signals.has("clinic") ||
    signals.has("junior") ||
    signals.has("camp");

  const hasMembershipSignal =
    categories.has("membership") ||
    intents.has("membership_activity") ||
    signals.has("membership") ||
    signals.has("member");

  const hasMembershipEligibleBehavior =
    categories.has("tee_time") ||
    categories.has("simulator") ||
    intents.has("repeat_play") ||
    intents.has("practice_activity");

  const hasRepeatUse = input.visitCount >= 3;

  if (hasEventIntent) {
    return {
      key: "event_rebooking",
      opportunityType: "event",
      requiredPlaybookKey: "event-rebooking",
      signalSummary:
        "Customer has event, outing, private event, or corporate purchase signals. This supports an event rebooking motion.",
      nextBestAction:
        "Offer private event or group outing availability with a clear path to dates and package options.",
      replyHandlingGoal:
        "If they reply, qualify group size, preferred date range, budget, and event type before routing to booking.",
      baseConfidenceBoost: 12,
    } satisfies RecognizedOpportunity;
  }

  if (hasPracticeOrLessonIntent && input.isMember) {
    return {
      key: "member_lesson_rebooking",
      opportunityType: "lesson",
      requiredPlaybookKey: "lesson-rebooking",
      signalSummary:
        "Customer is already a member and has lesson, simulator, or practice activity. This supports a lesson rebooking motion, not a membership offer.",
      nextBestAction:
        "Offer available lesson times or a continuation session based on their recent practice behavior.",
      replyHandlingGoal:
        "If they reply, ask what they are working on and offer specific lesson availability.",
      baseConfidenceBoost: 12,
    } satisfies RecognizedOpportunity;
  }

  if (hasPracticeOrLessonIntent) {
    return {
      key: "practice_to_lesson",
      opportunityType: "lesson",
      requiredPlaybookKey: "lesson-package-upsell",
      signalSummary:
        "Customer has simulator, practice, coaching, or lesson purchase signals. This supports a lesson package motion.",
      nextBestAction:
        "Offer available private lesson times or a lesson package aligned with their practice activity.",
      replyHandlingGoal:
        "If they reply, ask about their improvement goal and offer specific lesson availability.",
      baseConfidenceBoost: 9,
    } satisfies RecognizedOpportunity;
  }

  if (hasClinicIntent) {
    return {
      key: "clinic_follow_up",
      opportunityType: "event",
      requiredPlaybookKey: "clinic-follow-up",
      signalSummary:
        "Customer has clinic, junior program, or camp purchase signals. This supports a follow-up into the next program.",
      nextBestAction:
        "Send upcoming clinic or junior program options and ask if they want details.",
      replyHandlingGoal:
        "If they reply, share upcoming program dates, age or skill fit, and enrollment next steps.",
      baseConfidenceBoost: 8,
    } satisfies RecognizedOpportunity;
  }

  if (
    hasRepeatUse &&
    hasMembershipEligibleBehavior &&
    !input.isMember &&
    !hasMembershipSignal
  ) {
    return {
      key: "repeat_guest_to_member",
      opportunityType: "membership",
      requiredPlaybookKey: "guest-to-member-conversion",
      signalSummary:
        "Customer has multiple paid visits, relevant repeat-use behavior, and is not marked as a member. This supports a membership conversation.",
      nextBestAction:
        "Invite them to review membership options based on their regular usage.",
      replyHandlingGoal:
        "If they reply, explain membership fit, gather expected usage, and offer current membership options.",
      baseConfidenceBoost: 10,
    } satisfies RecognizedOpportunity;
  }

  if (daysSincePurchase !== null && daysSincePurchase >= 30) {
    return {
      key: "inactive_customer_reactivation",
      opportunityType: "reactivation",
      requiredPlaybookKey: "customer-reactivation",
      signalSummary:
        "Customer has prior paid activity but has not purchased recently. This supports a reactivation motion.",
      nextBestAction:
        "Send a warm return visit message and make it easy to book the next session.",
      replyHandlingGoal:
        "If they reply, help them choose a time or route them to the right next booking option.",
      baseConfidenceBoost: 5,
    } satisfies RecognizedOpportunity;
  }

  return {
    key: "recent_buyer_follow_up",
    opportunityType: "reactivation",
    requiredPlaybookKey: "customer-reactivation",
    signalSummary:
      "Customer has recent paid purchase activity but no stronger category-specific opportunity was detected yet.",
    nextBestAction:
      "Send a short follow-up that helps them book their next session or identify the right next offer.",
    replyHandlingGoal:
      "If they reply, ask what they are looking to book next and route them to the right offer.",
    baseConfidenceBoost: 3,
  } satisfies RecognizedOpportunity;
}

function choosePlaybook(input: {
  playbooks: RevenuePlaybook[];
  recognizedOpportunity: RecognizedOpportunity;
  feedback?: FeedbackSummary;
}) {
  const preferredPlaybook = input.playbooks.find(
    (playbook) =>
      playbook.playbook_key === input.recognizedOpportunity.requiredPlaybookKey
  );

  if (
    preferredPlaybook &&
    !input.feedback?.wrongOfferPlaybooks.has(preferredPlaybook.playbook_key)
  ) {
    return preferredPlaybook;
  }

  const fallbackPlaybook = input.playbooks.find(
    (playbook) => playbook.playbook_key === "customer-reactivation"
  );

  return fallbackPlaybook ?? preferredPlaybook ?? input.playbooks[0];
}

function chooseMessageFromFramework(input: {
  framework: PlaybookMessageFramework | undefined;
  visitCount: number;
  totalSpendCents: number;
}) {
  const examples = input.framework?.example_messages ?? [];

  if (examples.length === 0) {
    return null;
  }

  const index =
    (input.visitCount + Math.round(input.totalSpendCents / 100)) %
    examples.length;

  return cleanMessage(examples[index]);
}

function buildRecommendedMessage(input: {
  businessProfile: BusinessProfile | null;
  playbook: RevenuePlaybook;
  framework: PlaybookMessageFramework | undefined;
  recognizedOpportunity: RecognizedOpportunity;
  visitCount: number;
  totalSpendCents: number;
}) {
  const frameworkMessage = chooseMessageFromFramework({
    framework: input.framework,
    visitCount: input.visitCount,
    totalSpendCents: input.totalSpendCents,
  });

  if (frameworkMessage) {
    return frameworkMessage;
  }

  const businessName = input.businessProfile?.business_name ?? "Primetime Golf";

  if (input.recognizedOpportunity.key === "member_lesson_rebooking") {
    return cleanMessage(
      `Hi, noticed you’ve been working on your game at ${businessName} recently. If you want to keep the momentum going, we have lesson times available this week. Want me to send over a few options?`
    );
  }

  if (input.recognizedOpportunity.key === "practice_to_lesson") {
    return cleanMessage(
      `Hi, noticed you’ve been practicing at ${businessName} recently. If you’re working on improving your game, a private lesson package could help you get more out of each session. Want me to send over a few available times?`
    );
  }

  if (input.recognizedOpportunity.key === "repeat_guest_to_member") {
    return cleanMessage(
      `Hi, you’ve been spending more time at ${businessName} recently. If you plan to keep playing regularly, membership may be a better fit than booking one visit at a time. Want me to send over the current options?`
    );
  }

  if (input.recognizedOpportunity.key === "event_rebooking") {
    return cleanMessage(
      `Hi, we’d love to help you plan another group outing at ${businessName}. We have upcoming availability for private events and can make the setup easy for your group. Want me to send a few available dates?`
    );
  }

  if (input.recognizedOpportunity.key === "clinic_follow_up") {
    return cleanMessage(
      `Hi, we have new clinic dates coming up at ${businessName}. Based on your past visit, we thought you might want early access before spots fill. Want me to send the details?`
    );
  }

  return cleanMessage(
    `Hi, thanks for visiting ${businessName} recently. We’d be happy to help you book your next session or recommend the best option for your goals.`
  );
}

function buildOpportunity(input: {
  businessProfile: BusinessProfile | null;
  playbooks: RevenuePlaybook[];
  frameworks: PlaybookMessageFramework[];
  totalSpendCents: number;
  visitCount: number;
  lastPurchaseAt: string | null;
  categories: string[];
  intents: string[];
  signals: string[];
  isMember: boolean;
  hasContactInfo: boolean;
  hasKnownIdentity: boolean;
  feedback?: FeedbackSummary;
}) {
  let score = 35;

  const recognizedOpportunity = recognizeOpportunity({
    categories: input.categories,
    intents: input.intents,
    signals: input.signals,
    visitCount: input.visitCount,
    totalSpendCents: input.totalSpendCents,
    lastPurchaseAt: input.lastPurchaseAt,
    isMember: input.isMember,
  });

  const lastPurchaseAt = input.lastPurchaseAt
    ? new Date(input.lastPurchaseAt)
    : null;

  const daysSincePurchase = lastPurchaseAt
    ? Math.floor((Date.now() - lastPurchaseAt.getTime()) / 86400000)
    : null;

  const uniqueCategories = Array.from(new Set(input.categories)).filter(
    Boolean
  );

  const knownCategories = uniqueCategories.filter(
    (category) => category !== "unknown"
  );

  const isUnknownOnly =
    uniqueCategories.length > 0 && knownCategories.length === 0;

  const hasStrongIntent =
    knownCategories.includes("simulator") ||
    knownCategories.includes("lesson") ||
    knownCategories.includes("clinic") ||
    knownCategories.includes("event") ||
    knownCategories.includes("tee_time") ||
    input.intents.includes("practice_activity") ||
    input.intents.includes("instruction_interest") ||
    input.intents.includes("program_interest") ||
    input.intents.includes("group_event_interest") ||
    input.intents.includes("repeat_play");

  if (input.totalSpendCents >= 100000) score += 25;
  else if (input.totalSpendCents >= 50000) score += 18;
  else if (input.totalSpendCents >= 10000) score += 10;

  if (input.visitCount >= 5) score += 25;
  else if (input.visitCount >= 2) score += 15;

  if (daysSincePurchase !== null && daysSincePurchase <= 14) score += 15;
  else if (daysSincePurchase !== null && daysSincePurchase <= 30) score += 10;
  else if (daysSincePurchase !== null && daysSincePurchase >= 45) score += 8;

  score += recognizedOpportunity.baseConfidenceBoost;

  if (input.feedback) {
    score += input.feedback.goodTargetCount * 5;
    score += input.feedback.convertedCount * 8;
    score -= input.feedback.wrongOfferCount * 10;
    score -= input.feedback.notInterestedCount * 12;
    score -= input.feedback.badDataCount * 30;
  }

  if (input.isMember && recognizedOpportunity.opportunityType === "membership") {
    score = Math.max(score - 40, 0);
  }

  let confidenceCap = 95;
  const guardrailReasons: string[] = [];

  if (isUnknownOnly) {
    confidenceCap = Math.min(confidenceCap, 65);
    guardrailReasons.push(
      "Confidence capped because purchases are currently categorized as unknown."
    );
  }

  if (!input.hasKnownIdentity) {
    confidenceCap = Math.min(confidenceCap, 65);
    guardrailReasons.push(
      "Confidence capped because the customer identity is incomplete."
    );
  }

  if (!input.hasContactInfo) {
    confidenceCap = Math.min(confidenceCap, 60);
    guardrailReasons.push(
      "Confidence capped because no email or phone is available for outreach."
    );
  }

  if (!hasStrongIntent && recognizedOpportunity.opportunityType !== "reactivation") {
    confidenceCap = Math.min(confidenceCap, 60);
    guardrailReasons.push(
      "Confidence capped because CloseOS does not yet have a strong category-specific intent signal."
    );
  }

  if (
    recognizedOpportunity.opportunityType === "membership" &&
    !knownCategories.includes("simulator") &&
    !knownCategories.includes("tee_time")
  ) {
    confidenceCap = Math.min(confidenceCap, 60);
    guardrailReasons.push(
      "Membership confidence capped because the customer does not have strong simulator or tee-time usage signals."
    );
  }

  if (
    recognizedOpportunity.opportunityType === "event" &&
    !knownCategories.includes("event") &&
    !input.intents.includes("group_event_interest")
  ) {
    confidenceCap = Math.min(confidenceCap, 60);
    guardrailReasons.push(
      "Event confidence capped because CloseOS does not have a true event, outing, or corporate signal."
    );
  }

  score = Math.max(0, Math.min(score, 100));

  const playbook = choosePlaybook({
    playbooks: input.playbooks,
    recognizedOpportunity,
    feedback: input.feedback,
  });

  const framework = input.frameworks.find(
    (candidate) => candidate.playbook_key === playbook?.playbook_key
  );

  const baseEstimatedRevenueCents = Math.max(
    playbook?.estimated_value_cents ?? 10000,
    Math.round(input.totalSpendCents / 2)
  );

  const estimatedRevenueCents =
    input.feedback && input.feedback.convertedRevenueCents > 0
      ? Math.max(baseEstimatedRevenueCents, input.feedback.convertedRevenueCents)
      : baseEstimatedRevenueCents;

  const confidence = Math.max(0, Math.min(score, confidenceCap));

  const feedbackNotes = [];

  if (input.feedback?.goodTargetCount) {
    feedbackNotes.push("Operator previously confirmed this as a good target.");
  }

  if (input.feedback?.wrongOfferCount) {
    feedbackNotes.push(
      "Operator previously flagged an offer issue, so CloseOS reduced confidence and avoided repeating the same playbook when possible."
    );
  }

  if (input.feedback?.convertedCount) {
    feedbackNotes.push(
      "A previous operator-marked conversion exists, so CloseOS increased confidence for similar revenue motion."
    );
  }

  if (input.feedback?.notInterestedCount) {
    feedbackNotes.push(
      "Customer was previously marked not interested, so CloseOS reduced priority."
    );
  }

  const reason = [
    `Recognized opportunity: ${recognizedOpportunity.key.replaceAll("_", " ")}.`,
    recognizedOpportunity.signalSummary,
    uniqueCategories.length > 0
      ? `Detected purchase categories: ${uniqueCategories.join(", ")}.`
      : null,
    input.isMember
      ? "Customer is marked as a member, so membership acquisition is not recommended."
      : null,
    input.visitCount > 1 ? `${input.visitCount} paid visits detected.` : null,
    input.totalSpendCents > 0
      ? `${Math.round(input.totalSpendCents / 100)} dollars in tracked spend.`
      : null,
    guardrailReasons.length > 0 ? guardrailReasons.join(" ") : null,
    feedbackNotes.length > 0 ? feedbackNotes.join(" ") : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    targetScore: score,
    confidence,
    opportunityType: recognizedOpportunity.opportunityType,
    estimatedRevenueCents,
    recommendedPlaybook: playbook?.playbook_key ?? "customer-reactivation",
    recommendedOffer:
      playbook?.offer_description ?? "Send personalized follow-up",
    reason,
    recommendedMessage: buildRecommendedMessage({
      businessProfile: input.businessProfile,
      playbook,
      framework,
      recognizedOpportunity,
      visitCount: input.visitCount,
      totalSpendCents: input.totalSpendCents,
    }),
    recognizedOpportunity: recognizedOpportunity.key,
    opportunitySignalSummary: recognizedOpportunity.signalSummary,
    nextBestAction: recognizedOpportunity.nextBestAction,
    replyHandlingGoal: recognizedOpportunity.replyHandlingGoal,
  };
}

async function fetchSquarePayments(accessToken: string, locationId?: string) {
  const payments: SquarePayment[] = [];
  const { beginTime, endTime } = getBackfillRange(30);
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      begin_time: beginTime,
      end_time: endTime,
      sort_order: "DESC",
      limit: "100",
    });

    if (locationId) {
      params.set("location_id", locationId);
    }

    if (cursor) {
      params.set("cursor", cursor);
    }

    const data = await squareFetch<{
      payments?: SquarePayment[];
      cursor?: string;
    }>(`/v2/payments?${params.toString()}`, accessToken);

    payments.push(...(data.payments ?? []));
    cursor = data.cursor;
  } while (cursor);

  return payments;
}
async function fetchSquareCustomersByIds(
  accessToken: string,
  customerIds: string[]
) {
  const customersById = new Map<string, SquareCustomer>();

  for (let index = 0; index < customerIds.length; index += 100) {
    const batch = customerIds.slice(index, index + 100);

    if (batch.length === 0) continue;

    const data = await squareFetch<{ customers?: SquareCustomer[] }>(
      "/v2/customers/bulk-retrieve",
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          customer_ids: batch,
        }),
      }
    );

    for (const customer of data.customers ?? []) {
      customersById.set(customer.id, customer);
    }

    await sleep(300);
  }

  return customersById;
}
async function fetchSquareOrders(accessToken: string, orderIds: string[]) {
  const ordersById = new Map<string, SquareOrder>();

  for (let index = 0; index < orderIds.length; index += 20) {
    const batch = orderIds.slice(index, index + 20);

    if (batch.length === 0) continue;

    const data = await squareFetch<{ orders?: SquareOrder[] }>(
      "/v2/orders/batch-retrieve",
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          order_ids: batch,
        }),
      }
    );

    for (const order of data.orders ?? []) {
      ordersById.set(order.id, order);
    }

    await sleep(300);
  }

  return ordersById;
}

async function upsertOpenOpportunities(input: {
  supabase: ReturnType<typeof getSupabaseAdmin>;
  opportunities: AiOpportunityWriteRow[];
}) {
  const supabase = input.supabase as any;

  let created = 0;
  let updated = 0;
  let skippedActive = 0;

  for (const opportunity of input.opportunities) {
    const { data: existingRows, error: existingError } = await supabase
      .from("ai_opportunities")
      .select("id, status")
      .eq("business_id", opportunity.business_id)
      .eq("customer_profile_id", opportunity.customer_profile_id)
      .eq("recognized_opportunity", opportunity.recognized_opportunity)
      .eq("playbook", opportunity.playbook)
      .in("status", ["open", "queued", "launched", "replied"])
      .limit(1);

    if (existingError) {
      throw new Error(
        `Failed to check existing opportunity: ${existingError.message}`
      );
    }

    const existing = existingRows?.[0] as
      | { id: string; status: string }
      | undefined;

    if (existing?.status === "launched" || existing?.status === "replied") {
      const { error: touchError } = await supabase
        .from("ai_opportunities")
        .update({
          confidence: opportunity.confidence,
          priority: opportunity.priority,
          estimated_revenue_cents: opportunity.estimated_revenue_cents,
          signal_summary: opportunity.signal_summary,
          next_best_action: opportunity.next_best_action,
          reply_handling_goal: opportunity.reply_handling_goal,
          last_evaluated_at: opportunity.last_evaluated_at,
          updated_at: opportunity.updated_at,
        })
        .eq("id", existing.id);

      if (touchError) {
        throw new Error(
          `Failed to refresh active opportunity: ${touchError.message}`
        );
      }

      skippedActive += 1;
      continue;
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from("ai_opportunities")
        .update({
          targeting_profile_id: opportunity.targeting_profile_id,
          priority: opportunity.priority,
          confidence: opportunity.confidence,
          estimated_revenue_cents: opportunity.estimated_revenue_cents,
          signal_summary: opportunity.signal_summary,
          next_best_action: opportunity.next_best_action,
          reply_handling_goal: opportunity.reply_handling_goal,
          recommended_message: opportunity.recommended_message,
          last_evaluated_at: opportunity.last_evaluated_at,
          updated_at: opportunity.updated_at,
        })
        .eq("id", existing.id);

      if (updateError) {
        throw new Error(`Failed to update opportunity: ${updateError.message}`);
      }

      updated += 1;
      continue;
    }

    const { error: insertError } = await supabase
      .from("ai_opportunities")
      .insert({
        ...opportunity,
        opened_at: new Date().toISOString(),
      });

    if (insertError) {
      throw new Error(`Failed to create opportunity: ${insertError.message}`);
    }

    created += 1;
  }

  return {
    opportunitiesCreated: created,
    opportunitiesUpdated: updated,
    activeOpportunitiesRefreshed: skippedActive,
  };
}

export async function POST(request: NextRequest) {
  try {
    const denied = await gateBusinessUserOrCron(request);
    if (denied) return denied;

    const supabase = getSupabaseAdmin();

    const [
      connectionResult,
      businessProfileResult,
      playbooksResult,
      frameworksResult,
      feedbackResult,
    ] = await Promise.all([
      supabase
        .from("square_connections")
        .select("access_token_encrypted, location_id, revoked_at")
        .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
        .single(),

      supabase
        .from("business_profile")
        .select(
          "business_name, brand_voice, sales_goal_cents, primary_revenue_streams, ideal_customer_types, ai_notes"
        )
        .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
        .single(),

      supabase
        .from("revenue_playbooks")
        .select(
          "playbook_key, name, opportunity_type, target_conditions, offer_description, estimated_value_cents, message_guidelines"
        )
        .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
        .eq("active", true),

      supabase
        .from("playbook_message_frameworks")
        .select(
          "playbook_key, goal, message_angle, primary_cta, tone_rules, avoid_rules, example_messages"
        )
        .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
        .eq("active", true),

      supabase
        .from("ai_feedback")
        .select(
          "customer_profile_id, targeting_profile_id, feedback_type, playbook, opportunity_type, previous_score, previous_confidence, should_exclude, should_mark_member, converted_revenue_cents, created_at"
        )
        .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID),
    ]);

    const connection = connectionResult.data as SquareConnection | null;
    const businessProfile =
      (businessProfileResult.data as BusinessProfile | null) ?? null;
    const playbooks = (playbooksResult.data ?? []) as RevenuePlaybook[];
    const frameworks =
      (frameworksResult.data ?? []) as PlaybookMessageFramework[];
    const feedbackRows = (feedbackResult.data ?? []) as AiFeedbackRow[];
    const feedbackByCustomerProfileId = summarizeFeedback(feedbackRows);

    if (connectionResult.error || !connection) {
      return NextResponse.json(
        {
          error: "Square is not connected",
          details: connectionResult.error?.message,
        },
        { status: 400 }
      );
    }

    if (connection.revoked_at) {
      return NextResponse.json(
        { error: "Square connection has been revoked" },
        { status: 400 }
      );
    }

    if (playbooksResult.error || playbooks.length === 0) {
      return NextResponse.json(
        {
          error: "No active revenue playbooks found",
          details: playbooksResult.error?.message,
        },
        { status: 400 }
      );
    }

    if (feedbackResult.error) {
      return NextResponse.json(
        {
          error: "Failed to load AI feedback",
          details: feedbackResult.error.message,
        },
        { status: 500 }
      );
    }

    const accessToken = decryptToken(connection.access_token_encrypted);

    const payments = await fetchSquarePayments(
      accessToken,
      connection.location_id ?? undefined
    );

    const completedPayments = payments.filter(
      (payment) =>
        payment.status === "COMPLETED" &&
        Boolean(payment.amount_money?.amount) &&
        (payment.amount_money?.amount ?? 0) > 0
    );

    const orderIds = Array.from(
      new Set(
        completedPayments
          .map((payment) => payment.order_id)
          .filter((orderId): orderId is string => Boolean(orderId))
      )
    ).slice(0, 50);

    const ordersById = await fetchSquareOrders(accessToken, orderIds);

    
const customerIds = Array.from(
  new Set(
    completedPayments
      .map((payment) => {
        const order = payment.order_id
          ? ordersById.get(payment.order_id)
          : null;

        return payment.customer_id ?? order?.customer_id ?? null;
      })
      .filter((customerId): customerId is string => Boolean(customerId))
  )
);
const squareCustomersById = await fetchSquareCustomersByIds(
  accessToken,
  customerIds.slice(0,50)
);
    if (customerIds.length > 0) {
     const customerRows = customerIds.map((customerId) => {
  const squareCustomer = squareCustomersById.get(customerId);

  return {
    business_id: PRIMETIME_GOLF_BUSINESS_ID,
    source: "square",
    external_customer_id: customerId,
    ...(squareCustomer?.given_name
      ? { first_name: squareCustomer.given_name }
      : {}),
    ...(squareCustomer?.family_name
      ? { last_name: squareCustomer.family_name }
      : {}),
    ...(squareCustomer?.email_address
      ? { email: squareCustomer.email_address }
      : {}),
    ...(squareCustomer?.phone_number
      ? { phone: squareCustomer.phone_number }
      : {}),
    ai_segment: "unclassified",
    ai_score: 0,
    updated_at: new Date().toISOString(),
  };
});

      const { error: customerUpsertError } = await supabase
        .from("customer_profiles")
        .upsert(customerRows, {
          onConflict: "source,external_customer_id",
        });

      if (customerUpsertError) {
        return NextResponse.json(
          {
            error: "Failed to save customer profiles",
            details: customerUpsertError.message,
          },
          { status: 500 }
        );
      }
    }

    const { data: profileRowsData, error: profileError } = await supabase
      .from("customer_profiles")
      .select(
        "id, external_customer_id, first_name, last_name, email, phone, is_member, exclude_from_ai_targeting"
      )
      .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
      .eq("source", "square");

    if (profileError) {
      return NextResponse.json(
        {
          error: "Failed to load customer profiles",
          details: profileError.message,
        },
        { status: 500 }
      );
    }

    const profileByExternalCustomerId = new Map(
      ((profileRowsData ?? []) as CustomerProfileLookup[]).map((profile) => [
        profile.external_customer_id,
        profile,
      ])
    );

    const profileIdByExternalCustomerId = new Map(
      Array.from(profileByExternalCustomerId.entries()).map(
        ([externalCustomerId, profile]) => [externalCustomerId, profile.id]
      )
    );

    const purchaseRows = completedPayments.map((payment) => {
      const order = payment.order_id ? ordersById.get(payment.order_id) : null;
      const externalCustomerId =
        payment.customer_id ?? order?.customer_id ?? null;

      const itemNames =
        order?.line_items
          ?.map((item) => item.name)
          .filter((name): name is string => Boolean(name)) ?? [];

      const classification = classifyPurchase(itemNames);

      return {
        business_id: PRIMETIME_GOLF_BUSINESS_ID,
        customer_profile_id: externalCustomerId
          ? profileIdByExternalCustomerId.get(externalCustomerId) ?? null
          : null,
        source: "square",
        external_payment_id: payment.id,
        external_order_id: payment.order_id ?? null,
        external_customer_id: externalCustomerId,
        amount_cents: payment.amount_money?.amount ?? 0,
        currency: payment.amount_money?.currency ?? "USD",
        purchase_category: classification.category,
        opportunity_type: classification.opportunityType,
        detected_intent: classification.intent,
        item_names: itemNames,
        occurred_at: payment.created_at,
        raw_payload: {
          payment,
          order,
          classification,
        },
        updated_at: new Date().toISOString(),
      };
    });

    const memberCustomerIds = Array.from(
      new Set(
        purchaseRows
          .filter((purchase) => purchase.purchase_category === "membership")
          .map((purchase) => purchase.external_customer_id)
          .filter((customerId): customerId is string => Boolean(customerId))
      )
    );

    if (memberCustomerIds.length > 0) {
      const { error: memberUpdateError } = await supabase
        .from("customer_profiles")
        .update({
          is_member: true,
          exclude_from_ai_targeting: false,
          exclusion_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
        .eq("source", "square")
        .in("external_customer_id", memberCustomerIds);

      if (memberUpdateError) {
        return NextResponse.json(
          {
            error: "Failed to update member profiles",
            details: memberUpdateError.message,
          },
          { status: 500 }
        );
      }

      for (const memberCustomerId of memberCustomerIds) {
        const profile = profileByExternalCustomerId.get(memberCustomerId);

        if (profile) {
          profile.is_member = true;
          profile.exclude_from_ai_targeting = false;
        }
      }
    }

    const feedbackMemberProfileIds = Array.from(
      feedbackByCustomerProfileId.entries()
        .filter(([, feedback]) => feedback.shouldMarkMember)
        .map(([customerProfileId]) => customerProfileId)
    );

    if (feedbackMemberProfileIds.length > 0) {
      const { error: feedbackMemberError } = await supabase
        .from("customer_profiles")
        .update({
          is_member: true,
          updated_at: new Date().toISOString(),
        })
        .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
        .in("id", feedbackMemberProfileIds);

      if (feedbackMemberError) {
        return NextResponse.json(
          {
            error: "Failed to apply member feedback",
            details: feedbackMemberError.message,
          },
          { status: 500 }
        );
      }
    }

    const feedbackExcludeProfileIds = Array.from(
      feedbackByCustomerProfileId.entries()
        .filter(([, feedback]) => feedback.shouldExclude)
        .map(([customerProfileId]) => customerProfileId)
    );

    if (feedbackExcludeProfileIds.length > 0) {
      const { error: feedbackExcludeError } = await supabase
        .from("customer_profiles")
        .update({
          exclude_from_ai_targeting: true,
          exclusion_reason: "Excluded by operator feedback",
          updated_at: new Date().toISOString(),
        })
        .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
        .in("id", feedbackExcludeProfileIds);

      if (feedbackExcludeError) {
        return NextResponse.json(
          {
            error: "Failed to apply exclusion feedback",
            details: feedbackExcludeError.message,
          },
          { status: 500 }
        );
      }
    }

    if (purchaseRows.length > 0) {
      const { error: purchaseUpsertError } = await supabase
        .from("purchase_history")
        .upsert(purchaseRows, {
          onConflict: "source,external_payment_id",
        });

      if (purchaseUpsertError) {
        return NextResponse.json(
          {
            error: "Failed to save purchase history",
            details: purchaseUpsertError.message,
          },
          { status: 500 }
        );
      }
    }

    const { data: purchaseStatsData, error: statsError } = await supabase
      .from("purchase_history")
      .select(
        "external_customer_id, amount_cents, occurred_at, purchase_category, opportunity_type, detected_intent"
      )
      .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
      .not("external_customer_id", "is", null)
      .gt("amount_cents", 0);

    if (statsError) {
      return NextResponse.json(
        {
          error: "Failed to load purchase stats",
          details: statsError.message,
        },
        { status: 500 }
      );
    }

    const statsByCustomerId = new Map<
      string,
      {
        totalSpendCents: number;
        visitCount: number;
        lastPurchaseAt: string | null;
        categories: string[];
        intents: string[];
        signals: string[];
      }
    >();

    for (const purchase of (purchaseStatsData ?? []) as PurchaseStatRow[]) {
      const customerId = purchase.external_customer_id;

      const existing =
        statsByCustomerId.get(customerId) ??
        {
          totalSpendCents: 0,
          visitCount: 0,
          lastPurchaseAt: null,
          categories: [],
          intents: [],
          signals: [],
        };

      existing.totalSpendCents += purchase.amount_cents;
      existing.visitCount += 1;
      existing.categories.push(purchase.purchase_category);

      if (purchase.detected_intent) {
        existing.intents.push(purchase.detected_intent);
      }

      if (
        purchase.purchase_category !== "clinic" &&
        purchase.opportunity_type &&
        purchase.opportunity_type !== "event"
      ) {
        existing.signals.push(purchase.opportunity_type);
      }

      if (
        !existing.lastPurchaseAt ||
        new Date(purchase.occurred_at) > new Date(existing.lastPurchaseAt)
      ) {
        existing.lastPurchaseAt = purchase.occurred_at;
      }

      statsByCustomerId.set(customerId, existing);
    }

    const targetingRows: TargetingWriteRow[] = [];

    for (const [customerId, stats] of statsByCustomerId.entries()) {
      const customerProfile = profileByExternalCustomerId.get(customerId);

      if (!customerProfile) {
        continue;
      }

      const feedback = feedbackByCustomerProfileId.get(customerProfile.id);

      if (customerProfile.exclude_from_ai_targeting || feedback?.shouldExclude) {
        continue;
      }

      const isMember =
        customerProfile.is_member || Boolean(feedback?.shouldMarkMember);

      const hasContactInfo = Boolean(customerProfile.email || customerProfile.phone);

      const hasKnownIdentity = Boolean(
        customerProfile.first_name ||
          customerProfile.last_name ||
          customerProfile.email ||
          customerProfile.phone
      );

      const opportunity = buildOpportunity({
        businessProfile,
        playbooks,
        frameworks,
        isMember,
        feedback,
        hasContactInfo,
        hasKnownIdentity,
        ...stats,
      });

      const { error: profileUpdateError } = await supabase
        .from("customer_profiles")
        .update({
          total_spend_cents: stats.totalSpendCents,
          visit_count: stats.visitCount,
          last_purchase_at: stats.lastPurchaseAt,
          is_member: isMember,
          ai_segment: opportunity.recommendedPlaybook,
          ai_score: opportunity.targetScore,
          updated_at: new Date().toISOString(),
        })
        .eq("id", customerProfile.id);

      if (profileUpdateError) {
        return NextResponse.json(
          {
            error: "Failed to update customer profile",
            details: profileUpdateError.message,
          },
          { status: 500 }
        );
      }

      targetingRows.push({
        business_id: PRIMETIME_GOLF_BUSINESS_ID,
        customer_profile_id: customerProfile.id,
        target_score: opportunity.targetScore,
        recommended_playbook: opportunity.recommendedPlaybook,
        recommended_offer: opportunity.recommendedOffer,
        reason: opportunity.reason,
        opportunity_type: opportunity.opportunityType,
        estimated_revenue_cents: opportunity.estimatedRevenueCents,
        confidence: opportunity.confidence,
        recommended_message: opportunity.recommendedMessage,
        recognized_opportunity: opportunity.recognizedOpportunity,
        opportunity_signal_summary: opportunity.opportunitySignalSummary,
        next_best_action: opportunity.nextBestAction,
        reply_handling_goal: opportunity.replyHandlingGoal,
        last_evaluated_at: new Date().toISOString(),
      });
    }

    let opportunitiesCreated = 0;
    let opportunitiesUpdated = 0;
    let activeOpportunitiesRefreshed = 0;

    if (targetingRows.length > 0) {
      const { error: targetingError } = await supabase
        .from("ai_targeting_profiles")
        .upsert(targetingRows, {
          onConflict: "customer_profile_id",
        });

      if (targetingError) {
        return NextResponse.json(
          {
            error: "Failed to save targeting profiles",
            details: targetingError.message,
          },
          { status: 500 }
        );
      }

      const customerProfileIds = targetingRows.map(
        (row) => row.customer_profile_id
      );

      const { data: savedTargetingRows, error: savedTargetingError } =
        await supabase
          .from("ai_targeting_profiles")
          .select("id, customer_profile_id")
          .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
          .in("customer_profile_id", customerProfileIds);

      if (savedTargetingError) {
        return NextResponse.json(
          {
            error: "Failed to reload saved targeting profiles",
            details: savedTargetingError.message,
          },
          { status: 500 }
        );
      }

      const targetingIdByCustomerProfileId = new Map(
        ((savedTargetingRows ?? []) as Array<{
          id: string;
          customer_profile_id: string;
        }>).map((row) => [row.customer_profile_id, row.id])
      );

      const now = new Date().toISOString();

      const opportunityRows: AiOpportunityWriteRow[] = targetingRows.map(
        (row) => ({
          business_id: PRIMETIME_GOLF_BUSINESS_ID,
          customer_profile_id: row.customer_profile_id,
          targeting_profile_id:
            targetingIdByCustomerProfileId.get(row.customer_profile_id) ?? null,
          recognized_opportunity: row.recognized_opportunity,
          opportunity_type: row.opportunity_type,
          playbook: row.recommended_playbook,
          status: "open",
          priority: row.target_score,
          confidence: row.confidence,
          estimated_revenue_cents: row.estimated_revenue_cents,
          signal_summary: row.opportunity_signal_summary,
          next_best_action: row.next_best_action,
          reply_handling_goal: row.reply_handling_goal,
          recommended_message: row.recommended_message,
          source: "closeos",
          last_evaluated_at: now,
          updated_at: now,
        })
      );

      const opportunityResult = await upsertOpenOpportunities({
        supabase,
        opportunities: opportunityRows,
      });

      opportunitiesCreated = opportunityResult.opportunitiesCreated;
      opportunitiesUpdated = opportunityResult.opportunitiesUpdated;
      activeOpportunitiesRefreshed =
        opportunityResult.activeOpportunitiesRefreshed;
    }

    return NextResponse.json({
      paymentsFound: payments.length,
      completedPayments: completedPayments.length,
      ordersFetched: ordersById.size,
      customerIdsFound: customerIds.length,
      purchasesSaved: purchaseRows.length,
      membersDetected: memberCustomerIds.length,
      feedbackRowsLoaded: feedbackRows.length,
      feedbackProfilesLoaded: feedbackByCustomerProfileId.size,
      feedbackMembersApplied: feedbackMemberProfileIds.length,
      feedbackExclusionsApplied: feedbackExcludeProfileIds.length,
      targetingProfilesUpdated: targetingRows.length,
      opportunitiesCreated,
      opportunitiesUpdated,
      activeOpportunitiesRefreshed,
      playbooksLoaded: playbooks.length,
      messageFrameworksLoaded: frameworks.length,
      businessProfileLoaded: Boolean(businessProfile),
      recognitionEngine: "feedback-aware",
      guardrails: "enabled",
      opportunityEngine: "enabled",
    });
  } catch (error) {
    console.error("Square customer sync failed:", error);

    return NextResponse.json(
      {
        error: "Square customer sync failed",
        details: error instanceof Error ? error.message : "Unknown server error",
      },
      { status: 500 }
    );
  }
}