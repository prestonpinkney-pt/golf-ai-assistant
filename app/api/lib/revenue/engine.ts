/**
 * lib/revenue/engine.ts
 *
 * CloseOS Revenue Engine — Core Logic Layer
 *
 * Pure logic. No UI. No API calls. No side effects.
 * All functions are synchronous and deterministic given the same inputs.
 *
 * Exports:
 *   scoreLead                — Lead scoring with signal-based model
 *   getOutboundOpportunities — Opportunity detection across all trigger types
 *   prioritizeOpportunities  — Revenue-weighted priority sorting
 *   generateFollowUp         — Day-stage follow-up message generation
 *   getDailyOpportunities    — Top actionable opportunities for today
 *   runRevenuePipeline       — Full pipeline: detect → sort → deduplicate with tags
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type Priority    = "high" | "medium" | "low";
export type RevenueType = "lesson" | "membership" | "event" | "general";
export type FollowUpDay = 1 | 2 | 3 | 7 | 14;

export type OpportunityType =
  | "ready_to_book"
  | "cold_lead_2h"
  | "cold_lead_24h"
  | "cold_lead_48h"
  | "cold_lead_3d"
  | "inactive_14d"
  | "empty_time_slot"
  | "unsold_event"
  | "membership_gap"
  | "lesson_upsell"
  | "reactivation";

/**
 * Minimal lead shape the engine needs.
 * Callers map their DB rows to this interface before calling engine functions.
 */
export interface Lead {
  id:    string;
  name:  string;
  phone: string | null;
  email: string | null;
  lead_type: RevenueType;

  // ── Scoring signals ────────────────────────────────────────────────────────

  /** Lead explicitly wants to book — asked for times, said they're ready. +50 */
  has_booking_intent:       boolean;
  /** Lead asked about availability or open slots. +40 */
  has_availability_inquiry: boolean;
  /** Lead asked about pricing or cost. +30 */
  has_pricing_inquiry:      boolean;
  /** Lead has completed at least one paid lesson. +35 */
  has_past_lesson:          boolean;

  // ── Intent timing ──────────────────────────────────────────────────────────

  /**
   * When booking intent was expressed (ISO string).
   * Not used for scoring. Used only to shape urgency in message copy.
   * When absent, standard direct close applies.
   */
  booking_intent_at?: string | null;

  // ── Customer context ───────────────────────────────────────────────────────

  /**
   * True when this lead is a returning customer (prior paid relationship).
   * Used for copy branching only — distinct from has_past_lesson (which is a score signal).
   */
  is_returning_customer?: boolean;

  // ── Revenue overrides ──────────────────────────────────────────────────────

  /**
   * For event leads: override default estimated revenue ($1,800).
   * When present and non-null, used instead of the default.
   * Has no effect on non-event leads.
   */
  event_value?: number | null;

  // ── Timestamps ────────────────────────────────────────────────────────────

  last_contact_at:  string | null; // last inbound message timestamp
  last_booked_at:   string | null; // last confirmed booking
  last_outbound_at: string | null; // last outbound message sent to this lead
  inquiry_at:       string | null; // when original enquiry was received
  created_at:       string;
}

/**
 * Supplementary context for opportunity detection —
 * facility state beyond individual leads.
 */
export interface FacilityContext {
  /** Time slots with no booking in the next 48 hours, as ISO timestamps */
  empty_slot_times:     string[];
  /** Event IDs with confirmed date but no bookings yet */
  unsold_event_ids:     string[];
  /** Lead IDs who held a membership that lapsed */
  lapsed_member_ids:    string[];
  /** Current UTC timestamp — injected for testability */
  now:                  string;
}

/** scoreLead output */
export interface LeadScore {
  score:            number;
  priority:         Priority;
  signals:          string[];
  /** Resolved estimated revenue for this lead. */
  expected_revenue: number;
}

/** Structured opportunity output */
export interface Opportunity {
  opportunity_type:    OpportunityType;
  lead_id:             string;
  lead_name:           string;
  lead_type:           RevenueType;
  priority:            Priority;
  score:               number;
  recommended_action:  string;
  suggested_message:   string;
  estimated_revenue:   number;
  expires_at:          string | null;
  /** True when opportunity was generated during a weak time block. */
  incentive_eligible?: boolean;
  /**
   * Secondary opportunity types matched for the same lead.
   * Only populated by runRevenuePipeline().
   * Primary type is never duplicated here.
   */
  opportunity_tags?:   string[];
  /**
   * Composite daily action score: estimated_revenue × urgency_multiplier × conversion_weight.
   * Only populated by getDailyOpportunities(). Never set by other functions.
   */
  daily_score?:        number;
}

/** generateFollowUp output */
export interface FollowUp {
  day:               FollowUpDay;
  tone:              "warm" | "value" | "urgency" | "reactivation" | "final";
  offer_logic:       string;
  suggested_message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Named constants — tune these without touching logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type-aware cooldown windows.
 *
 * READY_TO_BOOK : 0h  — always bypassed; handled structurally (see getOutboundOpportunities)
 * EARLY_STAGE   : 12h — inquiries under 24h old; faster follow-up cadence
 * LATE_STAGE    : 24h — inquiries 24h+ old; pacing protection for ghosting arc
 *
 * Fallback when inquiry_at is absent: EARLY_STAGE (conservative — assume recent inquiry)
 */
export const COOLDOWN_HOURS = {
  READY_TO_BOOK: 0,
  EARLY_STAGE:   12,
  LATE_STAGE:    24,
} as const;

/**
 * Stage 4 closing phrase — preserved verbatim.
 * Must not be paraphrased or weakened in any message variant.
 */
const STAGE_4_CLOSE = "What can I do to earn your business here?";

/** Minimum score for an empty slot opportunity to fire (unless has_past_lesson) */
const EMPTY_SLOT_MIN_SCORE = 40;

/**
 * Weak time block definitions.
 * Each entry is a day-of-week (0=Sun…6=Sat) + hour range (24h, inclusive start, exclusive end).
 */
const WEAK_TIME_BLOCKS: Array<{ days: number[]; fromHour: number; toHour: number }> = [
  { days: [1, 2, 3, 4, 5], fromHour: 0,  toHour: 10 }, // Weekday mornings before 10am
  { days: [1, 2, 3, 4, 5], fromHour: 13, toHour: 17 }, // Weekday afternoons 1pm–5pm
  { days: [0],              fromHour: 0,  toHour: 17 }, // Sundays before 5pm
];

/** Revenue type weighting — sort tiebreaker after estimated_revenue */
const REVENUE_TYPE_WEIGHT: Record<RevenueType, number> = {
  lesson:     3,
  membership: 2,
  event:      1,
  general:    0,
};

/** Default estimated revenue per conversion by type */
const ESTIMATED_REVENUE: Record<RevenueType, number> = {
  lesson:     90,
  membership: 149,
  event:      1800,
  general:    0,
};

/** Urgency multipliers for getDailyOpportunities composite scoring */
const URGENCY_MULTIPLIER: Partial<Record<OpportunityType, number>> & { default: number } = {
  ready_to_book:   2.0,
  cold_lead_2h:    1.5,
  cold_lead_24h:   1.5,
  cold_lead_48h:   1.5,
  cold_lead_3d:    1.5,
  empty_time_slot: 1.2, // +0.2 incentive boost applied inline when incentive_eligible
  default:         1.0,
};

/** Default number of opportunities returned by getDailyOpportunities */
const DAILY_LIMIT_DEFAULT = 5;

/** Priority bands */
const SCORE_THRESHOLD_HIGH   = 60;
const SCORE_THRESHOLD_MEDIUM = 30;

// ─────────────────────────────────────────────────────────────────────────────
// Internal utilities
// ─────────────────────────────────────────────────────────────────────────────

function parseDate(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

function hoursBetween(earlier: Date, later: Date): number {
  return Math.max(0, (later.getTime() - earlier.getTime()) / (1000 * 60 * 60));
}

function daysBetween(earlier: Date, later: Date): number {
  return hoursBetween(earlier, later) / 24;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function scoreToPriority(score: number): Priority {
  if (score >= SCORE_THRESHOLD_HIGH)   return "high";
  if (score >= SCORE_THRESHOLD_MEDIUM) return "medium";
  return "low";
}

function addHours(ts: string, hours: number): string {
  const d = new Date(ts);
  d.setTime(d.getTime() + hours * 60 * 60 * 1000);
  return d.toISOString();
}

function resolveRevenue(lead: Lead): number {
  if (lead.lead_type === "event" && lead.event_value != null) return lead.event_value;
  return ESTIMATED_REVENUE[lead.lead_type];
}

function firstName(lead: Lead): string {
  return lead.name.split(" ")[0];
}

/** Pure — deterministic for any given input. */
function isWeakTimeBlock(now: string): boolean {
  const d = parseDate(now);
  if (!d) return false;
  const day  = d.getDay();
  const hour = d.getHours();
  return WEAK_TIME_BLOCKS.some(
    b => b.days.includes(day) && hour >= b.fromHour && hour < b.toHour
  );
}

/**
 * Returns a copy urgency prefix based on how recently booking intent was expressed.
 * Used only in message copy — has no effect on scoring.
 *
 * < 1h  → time-sensitive opener
 * 1–6h  → earlier-today opener
 * > 6h or absent → "" (no prefix)
 */
function intentUrgencyPrefix(lead: Lead, now: Date): string {
  if (!lead.booking_intent_at) return "";
  const intentDate = parseDate(lead.booking_intent_at);
  if (!intentDate) return "";
  const hours = hoursBetween(intentDate, now);
  // Clamp elapsed hours to ≥0 to guard against future timestamps
  if (hours < 0) return "";
  if (hours < 1)  return "You just reached out — ";
  if (hours <= 6) return "I saw your message earlier today — ";
  return "";
}

/**
 * Resolve the applicable cooldown window for a lead.
 * Proxies the stage by elapsed time since inquiry_at.
 *
 *   < 24h since inquiry  → EARLY_STAGE (12h)
 *   ≥ 24h since inquiry  → LATE_STAGE  (24h)
 *   no inquiry_at        → EARLY_STAGE (conservative fallback)
 */
function resolveCooldownHours(lead: Lead, now: Date): number {
  const inquiryDate = parseDate(lead.inquiry_at);
  if (!inquiryDate) return COOLDOWN_HOURS.EARLY_STAGE;
  const hoursElapsed = hoursBetween(inquiryDate, now);
  return hoursElapsed < 24 ? COOLDOWN_HOURS.EARLY_STAGE : COOLDOWN_HOURS.LATE_STAGE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 1: Lead scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * scoreLead — additive signal model.
 *
 * Signals:
 *   has_booking_intent        +50  (strongest: lead explicitly wants to book)
 *   has_availability_inquiry  +40
 *   has_pricing_inquiry       +30
 *   has_past_lesson           +35
 *
 * Inactivity decay:
 *   -10 per full day since last_contact_at, capped at -50
 *   No decay when last_contact_at is null
 *
 * Score clamped to [0, 100].
 */
export function scoreLead(lead: Lead, now: string = new Date().toISOString()): LeadScore {
  const nowDate = parseDate(now) ?? new Date();
  let score     = 0;
  const signals: string[] = [];

  if (lead.has_booking_intent) {
    score += 50;
    signals.push("Booking intent (+50)");
  }
  if (lead.has_availability_inquiry) {
    score += 40;
    signals.push("Availability inquiry (+40)");
  }
  if (lead.has_pricing_inquiry) {
    score += 30;
    signals.push("Pricing inquiry (+30)");
  }
  if (lead.has_past_lesson) {
    score += 35;
    signals.push("Past lesson completed (+35)");
  }

  const lastContact = parseDate(lead.last_contact_at);
  if (lastContact) {
    const daysSince   = Math.floor(daysBetween(lastContact, nowDate));
    const decayAmount = Math.min(daysSince * 10, 50);
    if (decayAmount > 0) {
      score -= decayAmount;
      signals.push(`Inactivity decay: ${daysSince} day${daysSince !== 1 ? "s" : ""} (-${decayAmount})`);
    }
  }

  const finalScore = clamp(score);
  return {
    score:            finalScore,
    priority:         scoreToPriority(finalScore),
    signals,
    expected_revenue: resolveRevenue(lead),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: opportunity builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ready_to_book — fires on has_booking_intent === true.
 * No score threshold. Always highest priority.
 * Short-circuits all other triggers for this lead.
 * Bypasses cooldown entirely (enforced by evaluation order in getOutboundOpportunities).
 *
 * Message style: assumes the close — no soft phrasing, move directly to scheduling.
 */
function buildReadyToBook(lead: Lead, scored: LeadScore, now: Date): Opportunity {
  const fn     = firstName(lead);
  const prefix = intentUrgencyPrefix(lead, now);
  const type   = lead.lead_type;

  let message: string;
  switch (type) {
    case "lesson":
      message = prefix
        ? `${prefix}let's get you on the calendar. What time works best for you today?`
        : `Hey ${fn} — I have availability today. Let's get you on the calendar — what time works best?`;
      break;
    case "event":
      message = prefix
        ? `${prefix}let's lock in your date right now. What are you working with?`
        : `Hey ${fn} — let's lock in your event date today. Tell me what you're working with and I'll get it held immediately.`;
      break;
    case "membership":
      message = prefix
        ? `${prefix}let's get you signed up today. I can have it sorted in two minutes — what works for you?`
        : `Hey ${fn} — let's get your membership sorted today. I can have you set up in two minutes. What works?`;
      break;
    default:
      message = prefix
        ? `${prefix}let's get this sorted right now. What time works best for you?`
        : `Hey ${fn} — let's get this sorted today. What time works best for you?`;
  }

  return {
    opportunity_type:   "ready_to_book",
    lead_id:            lead.id,
    lead_name:          lead.name,
    lead_type:          lead.lead_type,
    priority:           "high",
    score:              scored.score,
    recommended_action: "Lead has active booking intent — close immediately",
    suggested_message:  message,
    estimated_revenue:  resolveRevenue(lead),
    expires_at:         addHours(new Date(now).toISOString(), 2),
  };
}

/**
 * Ghosting escalation — four-stage arc.
 * Returns null when elapsed time since inquiry does not fall in a stage window,
 * or when a follow-up has already been sent after the inquiry.
 */
function buildGhostingOpportunity(
  lead:   Lead,
  scored: LeadScore,
  now:    Date
): Opportunity | null {
  const inquiryDate = parseDate(lead.inquiry_at);
  if (!inquiryDate) return null;

  const hoursElapsed = hoursBetween(inquiryDate, now);

  // Suppress if a follow-up was sent after the inquiry
  const lastContact = parseDate(lead.last_contact_at);
  if (lastContact && lastContact > inquiryDate) return null;

  type Stage = {
    opType:   OpportunityType;
    minHours: number;
    maxHours: number;
    action:   string;
    expires:  number; // hours from inquiry_at
  };

  const stages: Stage[] = [
    { opType: "cold_lead_2h",  minHours: 2,  maxHours: 24, action: "First touch — inquiry is fresh. Warm close.",        expires: 24 },
    { opType: "cold_lead_24h", minHours: 24, maxHours: 48, action: "24h follow-up — lead is evaluating. Value close.",    expires: 48 },
    { opType: "cold_lead_48h", minHours: 48, maxHours: 72, action: "48h follow-up — urgency required. Direct close.",     expires: 72 },
    { opType: "cold_lead_3d",  minHours: 72, maxHours: 96, action: "3-day follow-up — final structured attempt.",         expires: 96 },
  ];

  const stage = stages.find(s => hoursElapsed >= s.minHours && hoursElapsed < s.maxHours);
  if (!stage) return null;

  return {
    opportunity_type:   stage.opType,
    lead_id:            lead.id,
    lead_name:          lead.name,
    lead_type:          lead.lead_type,
    priority:           scored.priority,
    score:              scored.score,
    recommended_action: stage.action,
    suggested_message:  buildGhostingMessage(lead, stage.opType),
    estimated_revenue:  resolveRevenue(lead),
    expires_at:         addHours(inquiryDate.toISOString(), stage.expires),
  };
}

function buildGhostingMessage(lead: Lead, opType: OpportunityType): string {
  const fn        = firstName(lead);
  const type      = lead.lead_type;
  const returning = lead.is_returning_customer ?? false;

  switch (opType) {
    // Stage 1 — warm_close
    case "cold_lead_2h":
      switch (type) {
        case "lesson":     return `Hey ${fn} — thanks for reaching out. I have availability this week. Let's get you on the calendar — what day works best?`;
        case "event":      return `Hey ${fn} — thanks for getting in touch. I can hold a date for you today. What are you working around?`;
        case "membership": return `Hey ${fn} — thanks for your interest. Let's get you signed up and sorted. What works for you?`;
        default:           return `Hey ${fn} — thanks for reaching out. Let's get you sorted today. What are you looking to book?`;
      }

    // Stage 2 — value_close
    case "cold_lead_24h":
      switch (type) {
        case "lesson":     return `Hey ${fn} — our instructors work on exactly what you want to improve. One session makes a real difference. Let's get you on the calendar — what day works this week?`;
        case "event":      return `Hey ${fn} — we handle everything end to end so your group can enjoy the whole experience. Let's get a date locked in — what are you working with?`;
        case "membership": return `Hey ${fn} — at your frequency, membership pays for itself fast. Let's get you on the calendar today. What would make it easy to move forward?`;
        default:           return `Hey ${fn} — still happy to help get you sorted. Let's get something on the calendar — what works best?`;
      }

    // Stage 3 — urgency_close
    case "cold_lead_48h":
      switch (type) {
        case "lesson":     return `Hey ${fn} — our instructor has limited availability this week. I'd love to earn your business here — what can I do to get you booked in?`;
        case "event":      return `Hey ${fn} — a few of our best dates are going fast. What can I do to earn your event booking? I can hold a date right now.`;
        case "membership": return `Hey ${fn} — I want to make this easy. What can I do to earn your business today? I can get you set up in the next five minutes.`;
        default:           return `Hey ${fn} — one more from me. What can I do to earn your business here? Happy to get you sorted today.`;
      }

    // Stage 4 — final_close
    // STAGE_4_CLOSE must appear verbatim in every variant
    case "cold_lead_3d":
      if (returning) {
        return `Hey ${fn} — I know life gets busy. We'd genuinely love to have you back. ${STAGE_4_CLOSE}`;
      }
      switch (type) {
        case "lesson":     return `Hey ${fn} — I'll keep this short. I have a lesson slot available and I want to fill it with the right person. ${STAGE_4_CLOSE}`;
        case "event":      return `Hey ${fn} — last note from me on the event. I want to make this work for you. ${STAGE_4_CLOSE}`;
        case "membership": return `Hey ${fn} — one last check-in. I'm ready to get you sorted today. ${STAGE_4_CLOSE}`;
        default:           return `Hey ${fn} — last one from me. I want to make this as easy as possible. ${STAGE_4_CLOSE}`;
      }

    default:
      return `Hey ${fn} — still here if you want to get something booked. What works for you?`;
  }
}

/**
 * Empty time slot — only fires for warm lesson leads or returning customers.
 * Targeting: lead_type === "lesson" AND (score >= EMPTY_SLOT_MIN_SCORE OR has_past_lesson)
 */
function buildEmptySlotOpportunity(
  lead:          Lead,
  scored:        LeadScore,
  slotTime:      string,
  weakTimeBlock: boolean
): Opportunity | null {
  if (lead.lead_type !== "lesson") return null;
  const isWarmEnough = scored.score >= EMPTY_SLOT_MIN_SCORE || lead.has_past_lesson;
  if (!isWarmEnough) return null;

  const fn        = firstName(lead);
  const slotLabel = new Date(slotTime).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });

  const message = weakTimeBlock
    ? `Hey ${fn} — we have a slot open right now (${slotLabel}). Let's get you on the calendar today — does that time work?`
    : `Hey ${fn} — a lesson slot just opened up on ${slotLabel}. Let's lock it in — does that work for you?`;

  return {
    opportunity_type:   "empty_time_slot",
    lead_id:            lead.id,
    lead_name:          lead.name,
    lead_type:          lead.lead_type,
    priority:           weakTimeBlock ? "high" : "medium",
    score:              scored.score,
    recommended_action: `Slot available ${slotLabel} — warm lesson leads only`,
    suggested_message:  message,
    estimated_revenue:  resolveRevenue(lead),
    expires_at:         slotTime,
    incentive_eligible: weakTimeBlock,
  };
}

function buildUnsoldEventOpportunity(
  lead:    Lead,
  scored:  LeadScore,
  eventId: string
): Opportunity {
  const fn = firstName(lead);
  return {
    opportunity_type:   "unsold_event",
    lead_id:            lead.id,
    lead_name:          lead.name,
    lead_type:          "event",
    priority:           "high",
    score:              scored.score,
    recommended_action: `Promote event ${eventId} — no bookings yet`,
    suggested_message:  `Hey ${fn} — we have a private event date that matches exactly what you were after. Let's get your group locked in — want me to hold it today?`,
    estimated_revenue:  resolveRevenue(lead),
    expires_at:         null,
  };
}

function buildMembershipGapOpportunity(lead: Lead, scored: LeadScore): Opportunity {
  const fn = firstName(lead);
  return {
    opportunity_type:   "membership_gap",
    lead_id:            lead.id,
    lead_name:          lead.name,
    lead_type:          "membership",
    priority:           scored.priority,
    score:              scored.score,
    recommended_action: "Lapsed member — reactivation offer",
    suggested_message:  `Hey ${fn} — we'd love to have you back. We have a reactivation offer available right now. Let's get you signed up and back on the calendar — want to take it today?`,
    estimated_revenue:  ESTIMATED_REVENUE.membership,
    expires_at:         null,
  };
}

function buildInactivityOpportunity(
  lead:   Lead,
  scored: LeadScore,
  now:    Date
): Opportunity | null {
  const lastContact = parseDate(lead.last_contact_at) ?? parseDate(lead.created_at);
  if (!lastContact) return null;
  const daysSince = daysBetween(lastContact, now);
  if (daysSince < 14) return null;

  const fn        = firstName(lead);
  const returning = lead.is_returning_customer ?? false;
  const message   = returning
    ? `Hey ${fn} — it's been a while and we'd love to get you back in. Let's find you a time — what works this week?`
    : `Hey ${fn} — we have availability this week and I'd love to get you in. What day works best for you?`;

  return {
    opportunity_type:   "inactive_14d",
    lead_id:            lead.id,
    lead_name:          lead.name,
    lead_type:          lead.lead_type,
    priority:           daysSince >= 30 ? "low" : scored.priority,
    score:              scored.score,
    recommended_action: `Re-engage — ${Math.floor(daysSince)} days since last contact`,
    suggested_message:  message,
    estimated_revenue:  resolveRevenue(lead),
    expires_at:         null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 2: Outbound opportunity detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getOutboundOpportunities — detects all opportunities across a lead set.
 *
 * Evaluation order per lead:
 *
 *   STEP 1 — ready_to_book check (BEFORE cooldown)
 *     If has_booking_intent === true:
 *       → emit ready_to_book
 *       → continue (short-circuit: no other triggers run for this lead)
 *
 *   STEP 2 — Cooldown gate (only for non-ready_to_book leads)
 *     Type-aware cooldown via resolveCooldownHours():
 *       < 24h since inquiry → 12h cooldown
 *       ≥ 24h since inquiry → 24h cooldown
 *     If last_outbound_at is within cooldown window → skip lead
 *
 *   STEP 3 — Remaining triggers (only reached when not ready_to_book and not cooled)
 *     3a. Ghosting escalation (2h, 24h, 48h, 3d)
 *     3b. Inactivity (14d+) — only if no ghosting trigger fired
 *     3c. Empty slot — warm/returning lesson leads + soonest slot
 *     3d. Unsold events — event leads × unsold event IDs
 *     3e. Membership gap — lapsed member IDs
 */
export function getOutboundOpportunities(
  leads:   Lead[],
  context: FacilityContext
): Opportunity[] {
  const now       = parseDate(context.now) ?? new Date();
  const results:  Opportunity[] = [];
  const lapsedSet = new Set(context.lapsed_member_ids);
  const weakBlock = isWeakTimeBlock(context.now);

  for (const lead of leads) {
    if (!lead.phone) continue;

    const scored = scoreLead(lead, context.now);

    // ── STEP 1: ready_to_book — evaluated BEFORE cooldown ─────────────────
    // has_booking_intent === true fires immediately and short-circuits everything else.
    // Cooldown does not apply to this trigger.
    if (lead.has_booking_intent) {
      results.push(buildReadyToBook(lead, scored, now));
      continue;
    }

    // ── STEP 2: Cooldown gate — only for non-ready_to_book leads ──────────
    const lastOutbound     = parseDate(lead.last_outbound_at);
    const cooldownRequired = resolveCooldownHours(lead, now);
    if (lastOutbound && hoursBetween(lastOutbound, now) < cooldownRequired) {
      continue;
    }

    // ── STEP 3: Remaining triggers ─────────────────────────────────────────

    // 3a. Ghosting escalation
    const ghostingOp = buildGhostingOpportunity(lead, scored, now);
    if (ghostingOp) results.push(ghostingOp);

    // 3b. Inactivity — only when no ghosting trigger fired
    if (!ghostingOp) {
      const inactiveOp = buildInactivityOpportunity(lead, scored, now);
      if (inactiveOp) results.push(inactiveOp);
    }

    // 3c. Empty slot — warm/returning lesson leads only
    if (context.empty_slot_times.length > 0) {
      const soonestSlot = context.empty_slot_times
        .map(t => ({ t, ms: new Date(t).getTime() }))
        .sort((a, b) => a.ms - b.ms)[0];
      if (soonestSlot) {
        const slotOp = buildEmptySlotOpportunity(lead, scored, soonestSlot.t, weakBlock);
        if (slotOp) results.push(slotOp);
      }
    }

    // 3d. Unsold events
    if (lead.lead_type === "event" && context.unsold_event_ids.length > 0) {
      for (const eventId of context.unsold_event_ids) {
        results.push(buildUnsoldEventOpportunity(lead, scored, eventId));
      }
    }

    // 3e. Membership gap
    if (lapsedSet.has(lead.id)) {
      results.push(buildMembershipGapOpportunity(lead, scored));
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 3: Revenue prioritization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * prioritizeOpportunities — four-tier sort:
 *
 *   Tier 0 (pre-sort): ready_to_book always above all others
 *   Tier 1: estimated_revenue descending
 *   Tier 2: score descending
 *   Tier 3: expires_at ascending (null = furthest future)
 */
export function prioritizeOpportunities(opportunities: Opportunity[]): Opportunity[] {
  return [...opportunities].sort((a, b) => {
    // Tier 0: ready_to_book wins unconditionally
    const aReady = a.opportunity_type === "ready_to_book" ? 1 : 0;
    const bReady = b.opportunity_type === "ready_to_book" ? 1 : 0;
    if (bReady !== aReady) return bReady - aReady;

    // Tier 1: estimated revenue descending
    const revDiff = b.estimated_revenue - a.estimated_revenue;
    if (revDiff !== 0) return revDiff;

    // Tier 2: score descending
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;

    // Tier 3: expiry ascending
    const aExpiry = a.expires_at ? new Date(a.expires_at).getTime() : Infinity;
    const bExpiry = b.expires_at ? new Date(b.expires_at).getTime() : Infinity;
    return aExpiry - bExpiry;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 4: Follow-up engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * generateFollowUp — day-stage-specific follow-up copy.
 *
 * Day 1  — warm        : Acknowledge. Helpful. Booking ask.
 * Day 2  — value       : Lead with outcome. Direct close.
 * Day 3  — urgency     : Scarcity + "What can I do to earn your business?"
 * Day 7  — reactivation: Curiosity hook. One question.
 * Day 14 — final       : One sentence. Open door. No push.
 */
export function generateFollowUp(lead: Lead, dayStage: FollowUpDay): FollowUp {
  const config     = FOLLOW_UP_DAY_CONFIG[dayStage];
  const offerLogic = buildFollowUpOfferLogic(lead, dayStage);
  const message    = buildFollowUpMessage(lead, dayStage);
  return { day: dayStage, tone: config.tone, offer_logic: offerLogic, suggested_message: message };
}

const FOLLOW_UP_DAY_CONFIG: Record<FollowUpDay, { tone: FollowUp["tone"] }> = {
  1:  { tone: "warm"         },
  2:  { tone: "value"        },
  3:  { tone: "urgency"      },
  7:  { tone: "reactivation" },
  14: { tone: "final"        },
};

function buildFollowUpOfferLogic(lead: Lead, day: FollowUpDay): string {
  const type = lead.lead_type;
  switch (day) {
    case 1:
      return `Warm acknowledgement. No offer yet — make it easy to respond. ${
        type === "lesson"     ? "Offer to answer questions and get on the calendar." :
        type === "event"      ? "Offer to walk through event options." :
        type === "membership" ? "Offer to explain what's included and get them set up." :
                                "Offer to help them figure out the right next step."
      }`;
    case 2:
      return type === "lesson"
        ? "Lead with outcome: improvement, confidence, skill focus. Direct calendar close."
        : type === "event"
        ? "Lead with ease: handled end to end. Offer to lock in a date right now."
        : "Lead with value: membership pays for itself. Get them signed up and on the calendar.";
    case 3:
      return `Urgency + direct close. ${
        type === "lesson"     ? "Limited instructor availability. Offer a specific slot." :
        type === "event"      ? "Calendar urgency — popular dates filling." :
                                "Pricing or access window. Direct ask."
      } Close with exact phrase: "${STAGE_4_CLOSE.replace("here", "")}"`;
    case 7:
      return "Re-engage with a curiosity hook. One question. No guilt, no pressure.";
    case 14:
      return "Final touch. One or two sentences. Leave the door open. Do not push.";
  }
}

function buildFollowUpMessage(lead: Lead, day: FollowUpDay): string {
  const fn        = firstName(lead);
  const type      = lead.lead_type;
  const returning = lead.is_returning_customer ?? false;

  switch (day) {
    case 1:
      switch (type) {
        case "lesson":     return `Hey ${fn} — just making sure your enquiry came through. I have availability this week. Let's find you a time — what works?`;
        case "event":      return `Hey ${fn} — thanks for the message. Let me walk you through what we can put together for your group.`;
        case "membership": return `Hey ${fn} — happy to help you get started. What would make it easy to take the next step?`;
        default:           return `Hey ${fn} — just making sure your message came through. What would you like to get sorted?`;
      }

    case 2:
      switch (type) {
        case "lesson":     return `Hey ${fn} — our instructors work on exactly what you want to improve. One session changes how you play. Let's get you on the calendar — what day works this week?`;
        case "event":      return `Hey ${fn} — we handle everything so your group can enjoy the whole experience. Let's get a date locked in today. What are you working with?`;
        case "membership": return `Hey ${fn} — if you're coming in regularly, membership pays for itself fast. Let's get you signed up and on the calendar. What works for you today?`;
        default:           return `Hey ${fn} — let's get you sorted. What would make it easy to get something on the calendar today?`;
      }

    case 3:
      switch (type) {
        case "lesson":     return `Hey ${fn} — limited availability this week. I'd love to get you booked in. ${STAGE_4_CLOSE}`;
        case "event":      return `Hey ${fn} — a couple of our best dates are going fast. I want to make this work for you. ${STAGE_4_CLOSE}`;
        case "membership": return `Hey ${fn} — I want to make this easy. ${STAGE_4_CLOSE} I can get you set up today.`;
        default:           return `Hey ${fn} — ${STAGE_4_CLOSE} Happy to get you sorted right now.`;
      }

    case 7:
      switch (type) {
        case "lesson":     return `Hey ${fn} — ${returning ? "still thinking about getting back on the course?" : "still thinking about getting some lessons in?"} Let me know and I'll find you a time today.`;
        case "event":      return `Hey ${fn} — ${returning ? "still looking to book another event?" : "whatever happened with the event?"} Happy to help if you're still looking.`;
        case "membership": return `Hey ${fn} — ${returning ? "still thinking about coming back?" : "still thinking about joining?"} One question: what's making it hard to decide?`;
        default:           return `Hey ${fn} — still something we can help with? I'm here whenever you're ready to move.`;
      }

    case 14:
      return `Hey ${fn} — I'll leave it here for now. Whenever the timing works, we'd be glad to have you. Just reply and I'll get you sorted.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline runner with opportunity_tags
// ─────────────────────────────────────────────────────────────────────────────

/**
 * runRevenuePipeline — full pipeline: detect → prioritize → deduplicate with tags.
 *
 * One primary opportunity per lead (highest ranked).
 * All other matched types preserved in opportunity_tags.
 * Primary type is never duplicated in tags.
 */
export function runRevenuePipeline(
  leads:   Lead[],
  context: FacilityContext
): Opportunity[] {
  const raw    = getOutboundOpportunities(leads, context);
  const sorted = prioritizeOpportunities(raw);

  const grouped = new Map<string, Opportunity[]>();
  for (const op of sorted) {
    const existing = grouped.get(op.lead_id);
    if (existing) existing.push(op);
    else grouped.set(op.lead_id, [op]);
  }

  const results: Opportunity[] = [];
  for (const [, ops] of grouped) {
    const [primary, ...rest] = ops;
    const tags = rest
      .map(o => o.opportunity_type)
      .filter((t, i, arr) => t !== primary.opportunity_type && arr.indexOf(t) === i);
    results.push({ ...primary, opportunity_tags: tags.length > 0 ? tags : undefined });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily revenue execution surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getDailyOpportunities — top actionable opportunities for today.
 *
 * Business rules (hard):
 *   1. ready_to_book opportunities are ALWAYS included, regardless of filter.
 *   2. ready_to_book always ranks at the top — no daily_score can outrank it.
 *   3. Within the ready_to_book tier, rank by daily_score descending.
 *   4. Non-ready_to_book opportunities are filtered to actionable-today,
 *      then ranked by daily_score descending.
 *   5. If fewer than `limit` opportunities exist after rules 1–4,
 *      backfill from the remaining pipeline (not already in the list).
 *
 * daily_score = estimated_revenue × urgency_multiplier × conversion_weight
 * conversion_weight: 1.0 placeholder — extend with per-type rates when available.
 */
export function getDailyOpportunities(
  leads:   Lead[],
  context: FacilityContext,
  limit:   number = DAILY_LIMIT_DEFAULT
): Opportunity[] {
  const pipeline    = runRevenuePipeline(leads, context);
  const nowMs       = (parseDate(context.now) ?? new Date()).getTime();
  const h24Ms       = 24 * 60 * 60 * 1000;

  const GHOSTING_TYPES = new Set<OpportunityType>([
    "cold_lead_2h", "cold_lead_24h", "cold_lead_48h", "cold_lead_3d",
  ]);

  function computeDailyScore(op: Opportunity): number {
    const base             = URGENCY_MULTIPLIER[op.opportunity_type] ?? URGENCY_MULTIPLIER.default;
    const incentiveBoost   = op.incentive_eligible ? 0.2 : 0;
    const urgencyMultiplier = base + incentiveBoost;
    const conversionWeight = 1.0; // placeholder — replace with per-type conversion rate data
    return op.estimated_revenue * urgencyMultiplier * conversionWeight;
  }

  // Separate ready_to_book from everything else
  const readyToBook    = pipeline.filter(op => op.opportunity_type === "ready_to_book");
  const nonReadyToBook = pipeline.filter(op => op.opportunity_type !== "ready_to_book");

  // Score all opportunities
  const scoredReady = readyToBook.map(op => ({ ...op, daily_score: computeDailyScore(op) }));
  const scoredNonReady = nonReadyToBook.map(op => ({ ...op, daily_score: computeDailyScore(op) }));

  // Filter non-ready_to_book to actionable-today set
  const actionableNonReady = scoredNonReady.filter(op => {
    if (GHOSTING_TYPES.has(op.opportunity_type)) return true;
    if (op.expires_at && new Date(op.expires_at).getTime() - nowMs <= h24Ms) return true;
    return false;
  });

  // Sort each tier by daily_score descending
  const sortByDailyScore = (a: Opportunity, b: Opportunity) =>
    (b.daily_score ?? 0) - (a.daily_score ?? 0);

  scoredReady.sort(sortByDailyScore);
  actionableNonReady.sort(sortByDailyScore);

  // Combine: ready_to_book always first (hard rule), then actionable non-ready
  const combined = [...scoredReady, ...actionableNonReady];

  if (combined.length >= limit) return combined.slice(0, limit);

  // Backfill from remaining pipeline (not already in combined)
  const includedIds = new Set(combined.map(o => o.lead_id));
  const backfill = scoredNonReady
    .filter(op => !actionableNonReady.some(a => a.lead_id === op.lead_id) && !includedIds.has(op.lead_id))
    .sort(sortByDailyScore);

  return [...combined, ...backfill].slice(0, limit);
}