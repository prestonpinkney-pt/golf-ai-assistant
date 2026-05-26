export type CloseOsAiBookingContext = {
  bookingTitle: string | null;
  bookingStatus: string | null;
  reservationType: string | null;
  lastBookingAt: string | null;
  daysSinceBooking: number | null;
} | null;

export type CloseOsAiCustomerProfile = {
  first_name: string | null;
  last_name: string | null;
  leadName: string;
  email: string | null;
  phone: string | null;
  is_member: boolean;
  total_spend_cents: number;
  visit_count: number;
  last_purchase_at: string | null;
};

export type CloseOsAiOpportunityRow = {
  id: string;
  recognized_opportunity: string;
  playbook: string;
  opportunity_type: string;
  source: string | null;
  confidence: number;
  estimated_revenue_cents: number;
  signal_summary: string | null;
  next_best_action: string | null;
  reply_handling_goal: string | null;
  recommended_message: string | null;
};

export type BuildCloseOsAiRecommendationInput = {
  opportunity: CloseOsAiOpportunityRow;
  customer: CloseOsAiCustomerProfile;
  bookingContext: CloseOsAiBookingContext;
  /** e.g. Booking Intelligence */
  sourceDisplayLabel: string;
  whooshAvailability?: {
    verified: boolean;
    hasExactTimes: boolean;
    daypart?: "weekday" | "sunday" | "general";
  } | null;
};

export type CloseOsAiRecommendation = {
  aiOpportunityReason: string;
  aiConfidenceReason: string;
  recommendedCampaign: string;
  recommendedOffer: string;
  recommendedMessage: string;
  recommendedChannel: "sms" | "email" | "review_only";
  nextBestAction: string;
  replyHandlingGoal: string;
  objectionHandlingNotes: string;
  followUpPlan: string;
};

const SMS_MAX = 300;

function labelize(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** First name for greetings; avoids empty or junk tokens. */
export function getFirstName(leadName: string): string {
  const raw = (leadName ?? "").trim();
  if (!raw) return "there";

  if (raw.includes(",")) {
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const firstLike = parts[parts.length - 1]!.split(/\s+/)[0] ?? "";
      const cleaned = firstLike.replace(/[^a-zA-ZÀ-ÿ'-]/g, "").trim();
      if (cleaned) return capitalizeWord(cleaned);
    }
  }

  const token = raw.split(/\s+/)[0] ?? "";
  const cleaned = token.replace(/[^a-zA-ZÀ-ÿ'-]/g, "").trim();
  if (!cleaned) return "there";
  return capitalizeWord(cleaned);
}

function capitalizeWord(s: string) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function hasUsablePhone(phone: string | null | undefined) {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
}

function capSms(text: string, max = SMS_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

function googleBookingSuffix(
  source: string | null,
  ctx: CloseOsAiBookingContext
): string {
  if (source !== "google_calendar_booking" || !ctx) return "";
  const bits: string[] = [];
  if (ctx.bookingTitle) bits.push(`“${ctx.bookingTitle}”`);
  if (ctx.reservationType) bits.push(labelize(ctx.reservationType));
  if (ctx.bookingStatus) bits.push(`status ${labelize(ctx.bookingStatus)}`);
  if (bits.length === 0) return " Calendar booking context is available.";
  return ` Based on their calendar: ${bits.join(" · ")}.`;
}

function confidenceExplanation(input: {
  confidence: number;
  playbook: string;
  opportunityType: string;
  signalSummary: string | null;
}) {
  const sig = (input.signalSummary ?? "").trim();
  const short = sig.length > 160 ? `${sig.slice(0, 157)}…` : sig;
  const tail = short
    ? ` Signal: ${short}`
    : ` Playbook “${labelize(input.playbook)}”, type “${labelize(input.opportunityType)}”.`;
  return `CloseOS set confidence at ${input.confidence}% from revenue and engagement rules.${tail}`;
}

function genericFallbackMessage(firstName: string, opportunityType: string) {
  return capSms(
    `Hi ${firstName}, this is Primetime Golf. We’d like to help with your next visit—want me to send a few options that fit what you’re working on? (${labelize(opportunityType)})`
  );
}

function reviewOnly(
  input: BuildCloseOsAiRecommendationInput,
  partial: Omit<CloseOsAiRecommendation, "recommendedChannel" | "recommendedMessage"> & {
    recommendedMessage?: string;
  }
): CloseOsAiRecommendation {
  return {
    ...partial,
    recommendedChannel: "review_only",
    recommendedMessage:
      partial.recommendedMessage?.trim() ||
      "Review identity and contact data before any outreach.",
  };
}

export function buildCloseOsAiRecommendation(
  input: BuildCloseOsAiRecommendationInput
): CloseOsAiRecommendation {
  const { opportunity, customer, bookingContext, sourceDisplayLabel } = input;
  const ro = opportunity.recognized_opportunity;
  const first = getFirstName(customer.leadName);
  const member = customer.is_member;
  const src = opportunity.source ?? "";
  const phoneOk = hasUsablePhone(customer.phone);
  const gCalSuffix = googleBookingSuffix(src, bookingContext);

  const aiConfidenceReason = confidenceExplanation({
    confidence: opportunity.confidence,
    playbook: opportunity.playbook,
    opportunityType: opportunity.opportunity_type,
    signalSummary: opportunity.signal_summary,
  });

  if (ro === "booked_but_no_square_match") {
    return reviewOnly(input, {
      aiOpportunityReason: `Calendar booking has contact hints but no linked customer profile. Resolve in CRM before outreach.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Identity Review",
      recommendedOffer: "Link or create customer profile",
      recommendedMessage: "",
      nextBestAction:
        "Match email/phone to Square or Whoosh, then link customer_profiles safely.",
      replyHandlingGoal: "No outreach until identity is confirmed.",
      objectionHandlingNotes:
        "Do not message until the correct person is verified.",
      followUpPlan:
        "1) Verify identity in Square/Whoosh. 2) Link profile. 3) Re-run booking sync and reopen as a normal opportunity.",
    });
  }

  if (!phoneOk) {
    return reviewOnly(input, {
      aiOpportunityReason: `No usable phone on file for SMS; ${sourceDisplayLabel} opportunity still needs a reachable channel.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Contact data completion",
      recommendedOffer: "Collect phone or use email-only motion (manual)",
      recommendedMessage: "",
      nextBestAction: "Add a valid mobile number or switch to email outreach manually.",
      replyHandlingGoal: "Establish a reachable channel before launching.",
      objectionHandlingNotes: "N/A until contact path is set.",
      followUpPlan:
        "1) Enrich phone from Square/Whoosh. 2) Confirm consent. 3) Re-run targets list.",
    });
  }

  const whoosh = input.whooshAvailability;
  const whooshVerified = whoosh?.verified === true;

  if (
    whooshVerified &&
    (ro === "slow_time_fill" ||
      ro === "weekday_open_bay_fill" ||
      ro === "sunday_open_bay_fill" ||
      ro === "simulator_open_bay_fill" ||
      ro === "simulator_rebooking_due" ||
      ro === "simulator_recent_guest_follow_up" ||
      ro === "simulator_cancelled_recovery" ||
      ro === "mailchimp_simulator_interest")
  ) {
    const generalMsg = capSms(
      `Hi ${first}, this is Primetime Golf. We have a few simulator windows this week if you want to get a round or practice session in. Want me to send a couple options?`
    );
    const sundayMsg = capSms(
      `Hi ${first}, this is Primetime Golf. Sunday has a few good simulator windows if you want to get a round in without the rush. Want me to send a couple options?`
    );
    const weekdayMsg = capSms(
      `Hi ${first}, this is Primetime Golf. We have a few weekday simulator windows before the evening rush. Want me to send a couple options?`
    );

    const daypart = whoosh?.daypart ?? "general";
    const msg =
      ro === "sunday_open_bay_fill" || daypart === "sunday"
        ? sundayMsg
        : ro === "weekday_open_bay_fill" || daypart === "weekday"
          ? weekdayMsg
          : generalMsg;

    return {
      aiOpportunityReason: `Whoosh-verified simulator availability (${whoosh?.daypart ?? "general"} daypart). No exact times promised in SMS.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Fill Simulator Time",
      recommendedOffer: "Simulator bay time",
      recommendedMessage: msg,
      recommendedChannel: "sms",
      nextBestAction:
        "If they reply yes, offer 2–3 Whoosh-confirmed windows (do not invent times).",
      replyHandlingGoal: "Book verified simulator time.",
      objectionHandlingNotes:
        "Do not quote specific tee times unless pulled from Whoosh sync.",
      followUpPlan:
        "1) Confirm interest. 2) Offer verified options from Whoosh. 3) Book in Whoosh.",
    };
  }

  const base = (): CloseOsAiRecommendation => {
    const msg = genericFallbackMessage(first, opportunity.opportunity_type);
    return {
      aiOpportunityReason: `${sourceDisplayLabel}: ${labelize(ro)}.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: labelize(opportunity.playbook),
      recommendedOffer: labelize(opportunity.opportunity_type),
      recommendedMessage: msg,
      recommendedChannel: "sms",
      nextBestAction:
        opportunity.next_best_action ??
        "Review the signal, pick the best offer, and launch manually when ready.",
      replyHandlingGoal:
        opportunity.reply_handling_goal ??
        "If they reply, qualify intent and route to booking.",
      objectionHandlingNotes:
        "If timing is bad, offer two windows. If cost is a concern, describe options without promising discounts.",
      followUpPlan:
        "Day 0: send draft. Day 3: one polite check-in if no reply. Day 7: mark for manual review.",
    };
  };

  if (ro === "booking_cancelled_recovery") {
    const lessonHint =
      bookingContext?.reservationType?.toLowerCase() === "lesson"
        ? "lesson"
        : "booking";
    return {
      aiOpportunityReason: `Cancelled ${lessonHint} on file — good moment to help them rebook without pressure.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Cancelled Lesson Recovery",
      recommendedOffer: "Help them rebook the cancelled lesson",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Looks like your ${lessonHint} was cancelled recently — want me to help find a better time to get you back on the calendar?`
      ),
      recommendedChannel: "sms",
      nextBestAction:
        "Confirm preferred day/time window and rebook the lesson (or equivalent booking).",
      replyHandlingGoal:
        "Get a new lesson time or ask what schedule works best.",
      objectionHandlingNotes:
        "Too busy: offer two easier time windows. Price concern: describe lesson options without discounting first. Not interested: mark not interested.",
      followUpPlan:
        "1) Send SMS draft (manual). 2) If reply, propose 2–3 times. 3) If no reply in 5 days, one gentle follow-up then pause.",
    };
  }

  if (ro === "lesson_rebooking_due") {
    const longGap =
      bookingContext?.daysSinceBooking != null &&
      bookingContext.daysSinceBooking > 90;
    const msg = longGap
      ? `Hi ${first}, this is Primetime Golf. We haven’t seen you for a lesson in a while. Want me to help you get back on the calendar?`
      : `Hi ${first}, this is Primetime Golf. It’s been a little while since your last lesson — want me to help find a good time for your next one?`;
    return {
      aiOpportunityReason: `Past lesson completed; no later lesson booked within the rebooking window.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Lesson Rebooking",
      recommendedOffer: "Next private lesson / lesson package",
      recommendedMessage: capSms(msg),
      recommendedChannel: "sms",
      nextBestAction:
        "Offer 2–3 lesson windows or ask which part of their game they want to work on next.",
      replyHandlingGoal: "Book the next lesson.",
      objectionHandlingNotes:
        "Schedule: offer two concrete slots. Goals: ask one clarifying question. Hesitation: suggest a shorter tune-up lesson.",
      followUpPlan:
        "1) Manual send SMS. 2) If interested, text 2–3 times. 3) If booked, close opportunity as converted.",
    };
  }

  if (ro === "clinic_progression") {
    return {
      aiOpportunityReason: `Completed clinic — natural progression to private lesson or next clinic.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Clinic-to-Lesson Conversion",
      recommendedOffer: "Private lesson or next clinic",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Since you joined a clinic with us, a good next step could be a private lesson to work on your swing. Want me to send a few options?`
      ),
      recommendedChannel: "sms",
      nextBestAction:
        "Ask whether they want a private lesson or the next clinic series.",
      replyHandlingGoal:
        "Determine whether they want private lesson or next clinic.",
      objectionHandlingNotes:
        "Preference for group: steer to next clinic. Preference for 1:1: steer to lesson with coach match.",
      followUpPlan:
        "1) Send options for lesson vs clinic. 2) Book fit call or time. 3) Confirm in calendar.",
    };
  }

  if (ro === "event_follow_up") {
    return {
      aiOpportunityReason: `Completed event booking — follow up for repeat group outings.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Event Follow-Up",
      recommendedOffer: "Rebook event / group outing",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Thanks again for booking with us. If you’re thinking about another group outing or event, I can help you find dates.`
      ),
      recommendedChannel: "sms",
      nextBestAction:
        "Qualify group size, date range, and event type before proposing venues/times.",
      replyHandlingGoal:
        "Qualify group size, date range, event type.",
      objectionHandlingNotes:
        "Budget: clarify headcount and date flexibility. Logistics: parking, bay count, F&B. Timing: offer month windows first.",
      followUpPlan:
        "1) Confirm group intent. 2) Send 2–3 date ranges. 3) Loop in events coordinator manually.",
    };
  }

  if (ro === "mailchimp_lesson_interest") {
    return {
      aiOpportunityReason: `Mailchimp signal: lesson interest.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Lesson Lead Follow-Up",
      recommendedOffer: "First lesson / intro lesson",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Saw you were interested in lessons. What part of your game are you trying to improve right now?`
      ),
      recommendedChannel: "sms",
      nextBestAction:
        "Qualify goal, skill level, and timing; route to lesson booking.",
      replyHandlingGoal:
        "Qualify goal and route to lesson booking.",
      objectionHandlingNotes:
        "Nervous beginner: reassure with intro path. Time-crunched: propose 30-min options if available.",
      followUpPlan:
        "1) Qualify goal in one question. 2) Offer 2–3 coach/time options. 3) Book and confirm.",
    };
  }

  if (ro === "mailchimp_simulator_interest") {
    return {
      aiOpportunityReason: `Mailchimp signal: simulator interest.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Simulator Booking Follow-Up",
      recommendedOffer: "Simulator time",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Saw you were interested in simulator time. Want me to send a few good times to come in this week?`
      ),
      recommendedChannel: "sms",
      nextBestAction: "Book simulator time with realistic duration options.",
      replyHandlingGoal: "Book simulator time.",
      objectionHandlingNotes:
        "Bay availability: offer alternate dayparts. First-timer: explain check-in flow briefly.",
      followUpPlan:
        "1) Offer 2–3 slots. 2) Confirm party size. 3) Send confirmation details manually.",
    };
  }

  if (ro === "practice_to_lesson") {
    return {
      aiOpportunityReason: `Practice activity suggests readiness for coached improvement.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Practice-to-Lesson Upsell",
      recommendedOffer: "Private lesson",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Saw you’ve been getting practice in. If you want help turning that practice into progress, we have private lesson options. Want me to send a few openings?`
      ),
      recommendedChannel: "sms",
      nextBestAction:
        "Turn practice activity into a booked lesson with a clear goal.",
      replyHandlingGoal: "Turn practice activity into lesson booking.",
      objectionHandlingNotes:
        "Not sure lesson is worth it: offer a single session path. Cost: describe options; do not invent discounts.",
      followUpPlan:
        "1) Acknowledge practice habit positively. 2) Propose two lesson times. 3) If no reply, one follow-up in a week.",
    };
  }

  if (ro === "recent_buyer_follow_up") {
    return {
      aiOpportunityReason: `Recent purchase at Primetime — good time to help plan the next visit.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Recent Buyer Follow-Up",
      recommendedOffer: "Next booking support",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Thanks for coming in recently. Want help booking your next session or finding the best option for what you’re working on?`
      ),
      recommendedChannel: "sms",
      nextBestAction:
        "Classify whether they want simulator, lesson, clinic, event, or membership follow-up.",
      replyHandlingGoal:
        "Classify whether they want simulator, lesson, clinic, event, or membership.",
      objectionHandlingNotes:
        "Unsure: ask one clarifying question about their goal. Busy: offer two narrow windows.",
      followUpPlan:
        "1) Thank + offer navigation help. 2) Route to the right SKU. 3) Book and confirm.",
    };
  }

  if (ro === "member_lesson_rebooking") {
    return {
      aiOpportunityReason: `Member lesson cadence opportunity — reinforce member value, no acquisition pitch.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Member Lesson Rebooking",
      recommendedOffer: "Member lesson support",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Want me to help get your next lesson on the calendar?`
      ),
      recommendedChannel: "sms",
      nextBestAction: "Book lesson and reinforce member value.",
      replyHandlingGoal: "Book lesson and reinforce member value.",
      objectionHandlingNotes:
        "Scheduling: offer member-preferred windows. Coach preference: capture if stated.",
      followUpPlan:
        "1) Propose times. 2) Confirm coach if needed. 3) Close loop when booked.",
    };
  }

  if (ro === "mailchimp_membership_interest") {
    if (member) {
      return {
        aiOpportunityReason: `Lead tagged membership interest, but profile is already a member — steer to usage, not acquisition.${gCalSuffix}`,
        aiConfidenceReason,
        recommendedCampaign: "Member Experience Check-In",
        recommendedOffer: "Next visit / lesson / simulator support",
        recommendedMessage: capSms(
          `Hi ${first}, this is Primetime Golf. Want help planning your next visit or getting a lesson on the calendar?`
        ),
        recommendedChannel: "sms",
        nextBestAction:
          "Offer member-appropriate next step (lesson, simulator, event) — do not pitch joining.",
        replyHandlingGoal:
          "Increase member utilization and satisfaction.",
        objectionHandlingNotes:
          "Do not pitch membership acquisition. Focus on booking help.",
        followUpPlan:
          "1) Offer scheduling help. 2) Capture preferred activity. 3) Book.",
      };
    }
    return {
      aiOpportunityReason: `Mailchimp signal: membership interest.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Membership Interest Follow-Up",
      recommendedOffer: "Membership conversation (manual qualification)",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Thanks for your interest in membership. Want me to help you find the best fit based on how often you plan to visit?`
      ),
      recommendedChannel: "sms",
      nextBestAction:
        "Qualify visit frequency and goals; route to staff for plan details (no auto-discounts).",
      replyHandlingGoal:
        "Schedule a membership conversation with clear expectations.",
      objectionHandlingNotes:
        "Price questions: describe paths without promising discounts. Compare options at a high level only.",
      followUpPlan:
        "1) Qualify fit. 2) Manual handoff to membership staff. 3) Track outcome in CRM.",
    };
  }

  if (ro === "repeat_guest_to_member" && member) {
    return {
      aiOpportunityReason: `Repeat guest signal, but customer is already a member — use loyalty framing.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Member Loyalty Touch",
      recommendedOffer: "Next lesson or simulator visit",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Want me to help line up your next visit or lesson?`
      ),
      recommendedChannel: "sms",
      nextBestAction: "Book next visit; reinforce member benefits lightly.",
      replyHandlingGoal: "Drive the next booked visit.",
      objectionHandlingNotes: "Do not pitch joining as a new member.",
      followUpPlan:
        "1) Propose two times. 2) Book. 3) Confirm details.",
    };
  }

  if (ro === "repeat_guest_to_member") {
    return {
      aiOpportunityReason: `Repeat guest pattern — gentle path toward membership consideration (manual).${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Guest-to-Member Nurture",
      recommendedOffer: "Membership fit conversation",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. You’ve been in a few times with us—if you want, I can help you explore the simplest membership option for how you like to play. Interested in a quick overview?`
      ),
      recommendedChannel: "sms",
      nextBestAction:
        "Qualify visit cadence; route to staff for membership details (no pricing promises).",
      replyHandlingGoal:
        "Earn permission for a membership conversation.",
      objectionHandlingNotes:
        "Not ready: offer lesson/simulator instead. Price: no invented discounts.",
      followUpPlan:
        "1) Soft ask. 2) If yes, manual handoff. 3) If no, pivot to booking help.",
    };
  }

  if (ro === "clinic_follow_up") {
    return {
      aiOpportunityReason: `Clinic attendance / follow-up window.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Clinic Follow-Up",
      recommendedOffer: "Next clinic or private lesson",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Want me to help you pick the next clinic—or a private lesson if you want more 1:1 time?`
      ),
      recommendedChannel: "sms",
      nextBestAction: "Choose next clinic vs lesson; propose concrete times.",
      replyHandlingGoal: "Book the next clinic or lesson step.",
      objectionHandlingNotes:
        "Group preference: clinic path. Individual attention: lesson path.",
      followUpPlan:
        "1) Ask preference. 2) Send two options. 3) Book.",
    };
  }

  if (ro === "event_rebooking") {
    return {
      aiOpportunityReason: `Event customer rebooking signal.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Event Rebooking",
      recommendedOffer: "Group event / outing",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. If you’re planning another event with us, want me to help you find a few date options that could work?`
      ),
      recommendedChannel: "sms",
      nextBestAction: "Qualify headcount, timeframe, and event style.",
      replyHandlingGoal: "Start a structured rebooking conversation.",
      objectionHandlingNotes:
        "Budget: clarify constraints without promising discounts.",
      followUpPlan:
        "1) Confirm intent. 2) Offer date ranges. 3) Manual coordinator handoff.",
    };
  }

  if (ro === "inactive_customer_reactivation") {
    return {
      aiOpportunityReason: `Inactivity pattern — respectful win-back.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Win-Back (Light Touch)",
      recommendedOffer: "Return visit (simulator or lesson)",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. It’s been a bit since we’ve seen you—want me to send a couple easy times to swing by if you’re interested?`
      ),
      recommendedChannel: "sms",
      nextBestAction:
        "Offer low-pressure return options; avoid heavy sales tone.",
      replyHandlingGoal: "Re-establish contact and book a visit if they want.",
      objectionHandlingNotes:
        "Not interested: thank them and stop. Busy: offer two narrow windows.",
      followUpPlan:
        "1) One message. 2) Single polite follow-up after a week if no reply. 3) Pause.",
    };
  }

  if (ro === "mailchimp_event_interest") {
    return {
      aiOpportunityReason: `Mailchimp signal: event interest.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Event Interest Follow-Up",
      recommendedOffer: "Event planning help",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Saw you were interested in events. Are you planning something for a group, or checking options for a smaller outing?`
      ),
      recommendedChannel: "sms",
      nextBestAction: "Qualify group size and timeframe.",
      replyHandlingGoal: "Determine event intent and route to coordinator.",
      objectionHandlingNotes: "Keep questions short; avoid over-promising capacity.",
      followUpPlan: "1) Qualify. 2) Manual coordinator follow-up. 3) Book hold if serious.",
    };
  }

  if (ro === "mailchimp_clinic_interest") {
    return {
      aiOpportunityReason: `Mailchimp signal: clinic interest.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Clinic Interest Follow-Up",
      recommendedOffer: "Clinic seat / series",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Saw you were interested in clinics. Want me to send the next dates that still have room?`
      ),
      recommendedChannel: "sms",
      nextBestAction: "Send clinic schedule options and skill fit.",
      replyHandlingGoal: "Book a clinic spot.",
      objectionHandlingNotes: "Skill level: reassure beginner-friendly framing if needed.",
      followUpPlan: "1) Offer dates. 2) Confirm spot. 3) Payment/registration manually.",
    };
  }

  if (ro === "mailchimp_junior_program_interest") {
    return {
      aiOpportunityReason: `Mailchimp signal: junior program interest.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Junior Program Follow-Up",
      recommendedOffer: "Junior program / lesson path",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Thanks for your interest in our junior programs. Want me to help you find the best starting option for your junior’s age and schedule?`
      ),
      recommendedChannel: "sms",
      nextBestAction: "Collect age, schedule, and experience level (manual safeguards).",
      replyHandlingGoal: "Route to junior program options safely.",
      objectionHandlingNotes: "Parent concerns: emphasize safety, coaching, and structure.",
      followUpPlan: "1) Qualify basics. 2) Staff handoff. 3) Confirm enrollment steps.",
    };
  }

  if (ro === "mailchimp_reactivation_interest") {
    return {
      aiOpportunityReason: `Mailchimp signal: reactivation interest.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Reactivation Follow-Up",
      recommendedOffer: "Return visit",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Want me to help you ease back in with a simple visit option that fits your schedule?`
      ),
      recommendedChannel: "sms",
      nextBestAction: "Offer two low-pressure return paths (simulator vs lesson).",
      replyHandlingGoal: "Book a return visit without pressure.",
      objectionHandlingNotes: "Long absence: keep tone welcoming, not guilt-inducing.",
      followUpPlan: "1) Offer options. 2) Book. 3) One follow-up max.",
    };
  }

  if (ro === "mailchimp_general_lead") {
    return {
      aiOpportunityReason: `General marketing lead — needs light qualification.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "General Lead Follow-Up",
      recommendedOffer: "Guided next step (lesson, sim, or clinic)",
      recommendedMessage: capSms(
        `Hi ${first}, this is Primetime Golf. Thanks for connecting with us—what are you hoping to work on next: lessons, simulator time, or a clinic?`
      ),
      recommendedChannel: "sms",
      nextBestAction: "Ask one qualifying question; route to the best SKU.",
      replyHandlingGoal: "Understand intent and book the right next step.",
      objectionHandlingNotes: "Unclear intent: offer three simple choices.",
      followUpPlan: "1) Qualify. 2) Propose times. 3) Book.",
    };
  }

  if (src === "google_calendar_booking") {
    return {
      aiOpportunityReason: `${sourceDisplayLabel}: ${labelize(ro)}.${gCalSuffix}`,
      aiConfidenceReason,
      recommendedCampaign: "Booking Intelligence",
      recommendedOffer: labelize(ro),
      recommendedMessage: capSms(
        opportunity.recommended_message?.trim() ||
          `Hi ${first}, this is Primetime Golf. Based on your calendar activity with us, want me to help line up a simple next step that fits your goals?`
      ),
      recommendedChannel: "sms",
      nextBestAction:
        opportunity.next_best_action ??
        "Review calendar context and choose the best manual next step.",
      replyHandlingGoal:
        opportunity.reply_handling_goal ??
        "If they reply, clarify timing and book the right product.",
      objectionHandlingNotes:
        "If the calendar signal is unclear, confirm details before promising specifics. Never imply they attended if status was cancelled.",
      followUpPlan:
        "1) Review booking context. 2) Send one tailored draft (manual). 3) Book or pause.",
    };
  }

  return base();
}
