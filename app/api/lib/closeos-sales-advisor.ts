import type { CloseOsPlaybookSummary } from "./closeos-playbook-engine";
import { slugifyCampaignName } from "./closeos-playbook-engine";
import type { OutboundOpportunityTarget } from "./opportunity-eligible-targets";

export type AdvisorRevenueSummary = {
  monthlyGoalCents: number;
  actualRevenueCents: number;
  remainingGapCents: number;
  goalCoveragePercent: number;
  knownPipelineCents: number;
  qualifiedLeadCount: number;
  revenueTbdCount: number;
  reviewOnlyCount: number;
  goalStatus: "configured" | "missing" | "duplicate_resolved";
};

/** What to do first / next / later — operator-facing buckets (not internal types). */
export type SellerStrand =
  | "close_first"
  | "build_pipeline"
  | "hidden_upsell"
  | "needs_review"
  | "do_not_prioritize";

export type AdvisorSuggestionType =
  | "close_first"
  | "hidden_upsell"
  | "membership_opportunity"
  | "lesson_package_opportunity"
  | "event_invite_opportunity"
  | "junior_program_opportunity"
  | "open_house_opportunity"
  | "pipeline_gap"
  | "manual_review"
  | "data_quality"
  | "do_not_prioritize";

export type AdvisorSuggestionPriority = "critical" | "high" | "medium" | "low";

export type AdvisorSuggestion = {
  id: string;
  type: AdvisorSuggestionType;
  /** Seller-facing bucket for dashboard ordering and labels. */
  strand: SellerStrand;
  title: string;
  priority: AdvisorSuggestionPriority;
  confidence: number;
  /** Dollar gap or upside where relevant; never invented list prices for TBD leads. */
  revenueImpactCents: number;
  targetCount: number;
  reasoning: string;
  /** Imperative next step the operator can take now. */
  recommendedAction: string;
  actionHref: string;
  supportingSignals: string[];
  caution?: string;
  suggestedMessageAngle?: string;
};

export type CloseOsSalesAdvisorResult = {
  generatedAt: string;
  /** One plain-language sentence on where the business stands this month. */
  businessHeadline: string;
  /** Same as businessHeadline (legacy field name). */
  headline: string;
  /** max(0, remaining gap minus known forecastable pipeline). */
  pipelineShortfallCents: number;
  summary: string;
  suggestions: AdvisorSuggestion[];
};

export type BuildCloseOsSalesAdvisorInput = {
  targets: OutboundOpportunityTarget[];
  playbooks: CloseOsPlaybookSummary[];
  revenueSummary: AdvisorRevenueSummary | null;
};

function sumKnownPipeline(ts: OutboundOpportunityTarget[]) {
  return ts.reduce((s, t) => s + t.knownPipelineContributionCents, 0);
}

function formatMoneyPlain(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Math.round(cents / 100));
}

function buildBusinessHeadline(
  revenueSummary: AdvisorRevenueSummary | null,
  targetsCount: number
): string {
  if (!revenueSummary) {
    return targetsCount > 0
      ? "You have people ready to work, but this month’s revenue picture is still loading—hit refresh after the next sync."
      : "Bring in bookings and purchases so CloseOS can line up goal, gap, and your sharpest next moves.";
  }
  const g = revenueSummary;
  if (g.goalStatus === "missing" || g.monthlyGoalCents <= 0) {
    return "Set a real monthly revenue goal for this location so CloseOS can measure the gap and how much forecastable pipeline covers it.";
  }
  if (g.remainingGapCents <= 0) {
    return `Booked revenue is at or past your ${formatMoneyPlain(g.monthlyGoalCents)} monthly goal—finish what is in flight or line up next month’s number.`;
  }
  const cov =
    g.remainingGapCents > 0
      ? Math.min(100, Math.round((g.knownPipelineCents / g.remainingGapCents) * 100))
      : 0;
  const short = Math.max(0, g.remainingGapCents - g.knownPipelineCents);
  if (g.knownPipelineCents >= g.remainingGapCents) {
    return `You are ${g.goalCoveragePercent}% of the way to goal with ${formatMoneyPlain(g.remainingGapCents)} left to close, and forecastable pipeline can cover that if it converts.`;
  }
  const tbdNote =
    g.revenueTbdCount > 0
      ? ` Another ${g.revenueTbdCount} warm ${g.revenueTbdCount === 1 ? "deal needs" : "deals need"} a clear price before they add to pipeline dollars.`
      : "";
  return `You are ${g.goalCoveragePercent}% of the way to goal (${formatMoneyPlain(g.remainingGapCents)} to go); forecastable pipeline covers about ${cov}% of that gap, leaving roughly ${formatMoneyPlain(short)} uncovered in hard dollars.${tbdNote}`;
}

function playbookHref(campaignName: string) {
  return `/opportunities/playbooks/${slugifyCampaignName(campaignName)}?campaign=${encodeURIComponent(campaignName)}`;
}

function findPlaybook(
  playbooks: CloseOsPlaybookSummary[],
  test: (pb: CloseOsPlaybookSummary) => boolean
): CloseOsPlaybookSummary | null {
  return playbooks.find(test) ?? null;
}

function campaignContains(name: string, needle: RegExp) {
  return needle.test(name.trim().toLowerCase());
}

const PRIORITY_RANK: Record<AdvisorSuggestionPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function sortSuggestions(list: AdvisorSuggestion[]) {
  return [...list].sort((a, b) => {
    const pr = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (pr !== 0) return pr;
    return b.revenueImpactCents - a.revenueImpactCents;
  });
}

export function buildCloseOsSalesAdvisor(
  input: BuildCloseOsSalesAdvisorInput
): CloseOsSalesAdvisorResult {
  const { targets, playbooks, revenueSummary } = input;
  const generatedAt = new Date().toISOString();
  const suggestions: AdvisorSuggestion[] = [];

  const knownPipelineCents =
    revenueSummary?.knownPipelineCents ?? sumKnownPipeline(targets);
  const qualifiedLeadCountFromApi =
    revenueSummary?.qualifiedLeadCount ?? null;
  const revenueTbdFromApi = revenueSummary?.revenueTbdCount ?? null;
  const gapCents = revenueSummary?.remainingGapCents ?? 0;

  const bookingIntel = targets.filter(
    (t) =>
      (t.opportunitySource ?? "").toLowerCase() === "google_calendar_booking" ||
      (t.sourceDisplayLabel ?? "").toLowerCase().includes("booking")
  );

  const cancelledRecovery = targets.filter(
    (t) =>
      t.recognizedOpportunity === "booking_cancelled_recovery" ||
      campaignContains(t.recommendedCampaign, /cancel/) ||
      (t.bookingStatus ?? "").toLowerCase() === "cancelled"
  );

  const lessonRebooking = targets.filter((t) => t.recognizedOpportunity === "lesson_rebooking_due");
  const practiceToLesson = targets.filter((t) => t.recognizedOpportunity === "practice_to_lesson");
  const recentBuyer = targets.filter((t) => t.recognizedOpportunity === "recent_buyer_follow_up");
  const identityGap = targets.filter((t) => t.recognizedOpportunity === "booked_but_no_square_match");
  const inactive = targets.filter((t) => t.recognizedOpportunity === "inactive_customer_reactivation");
  const mailchimpTargets = targets.filter((t) => (t.opportunitySource ?? "").toLowerCase() === "mailchimp");

  const repeatLessonSignals = targets.filter(
    (t) =>
      t.recognizedOpportunity === "lesson_rebooking_due" ||
      (t.visitCount >= 3 && /lesson/i.test(t.recommendedOffer + t.recommendedCampaign))
  );

  const membershipCandidates = targets.filter(
    (t) => !t.isMember && (t.visitCount >= 4 || t.totalSpendCents >= 50_000)
  );

  const juniorSignals = targets.filter((t) => {
    const ext = (t.externalCustomerId ?? "").toLowerCase();
    const name = (t.leadName ?? "").toLowerCase();
    const offer = (t.recommendedOffer ?? "").toLowerCase();
    const camp = (t.recommendedCampaign ?? "").toLowerCase();
    return (
      ext.includes("whoosh") ||
      /\b(jr|junior|youth|teen|kid)\b/i.test(name) ||
      /junior|youth|family/.test(offer + camp)
    );
  });

  const reviewOnlySoft = targets.filter(
    (t) => (t.recommendedChannel ?? "").toLowerCase() === "review_only" && t.confidence < 65
  );

  const eventSoftLeads = targets.filter((t) => {
    const ro = t.recognizedOpportunity;
    return (
      ro === "inactive_customer_reactivation" ||
      ro === "practice_to_lesson" ||
      ((t.opportunitySource ?? "").toLowerCase() === "mailchimp" &&
        t.recognizedOpportunity !== "booking_cancelled_recovery")
    );
  });

  // 1) close_first
  if (cancelledRecovery.length > 0) {
    const pb =
      findPlaybook(playbooks, (p) => campaignContains(p.campaignName, /cancel.*lesson|lesson.*cancel/)) ??
      findPlaybook(playbooks, (p) => cancelledRecovery.some((t) => t.recommendedCampaign === p.campaignName)) ??
      playbooks[0] ??
      null;
    const campaign = pb?.campaignName ?? cancelledRecovery[0]!.recommendedCampaign;
    suggestions.push({
      id: "close-first-cancelled-lesson",
      type: "close_first",
      strand: "close_first",
      title: "Start with cancelled lesson recovery",
      priority: "critical",
      confidence: 88,
      revenueImpactCents: sumKnownPipeline(cancelledRecovery),
      targetCount: cancelledRecovery.length,
      reasoning:
        "These customers already tried to book lessons and cancelled without a replacement. They are warmer than cold leads.",
      recommendedAction:
        "Open the cancelled-lesson campaign and personally rebook each person before chasing new leads.",
      actionHref: campaign ? playbookHref(campaign) : "/opportunities",
      supportingSignals: [
        `${cancelledRecovery.length} reachable people tied to cancelled or recovery signals`,
        bookingIntel.length > 0 ? "Calendar-backed bookings are in the mix" : "Calendar-backed signals present",
      ],
      suggestedMessageAngle:
        "We noticed your lesson slot opened up — want help rebooking before it fills?",
    });
  }

  // 2) manual_review
  if (identityGap.length > 0) {
    suggestions.push({
      id: "manual-review-booking-identity",
      type: "manual_review",
      strand: "needs_review",
      title: "Fix calendar names that do not match a customer yet",
      priority: "critical",
      confidence: 82,
      revenueImpactCents: 0,
      targetCount: identityGap.length,
      reasoning:
        "Some lesson bookings have contact info but are not safely matched to a paying customer record. Clean that up before any outreach.",
      recommendedAction:
        "Go to Opportunities, match or create the right customer for each unmatched calendar booking, then approve outreach.",
      actionHref: "/opportunities",
      supportingSignals: [
        `${identityGap.length} calendar booking${identityGap.length === 1 ? "" : "s"} need a safe customer match`,
      ],
      caution: "Do not auto-text until identity is confirmed.",
    });
  }

  // 3) pipeline_gap (known pipeline only — never TBD or open-house estimates)
  if (revenueSummary && gapCents > 0 && knownPipelineCents < gapCents) {
    const pct = Math.round((knownPipelineCents / gapCents) * 100);
    const shortfall = Math.max(0, gapCents - knownPipelineCents);
    const tbd =
      revenueTbdFromApi ??
      targets.filter((t) => t.revenueReviewRequired).length;
    const ql =
      qualifiedLeadCountFromApi ??
      targets.filter((t) => t.pipelineCategory === "qualified_lead").length;
    suggestions.push({
      id: "pipeline-gap-monthly-goal",
      type: "pipeline_gap",
      strand: "build_pipeline",
      title: "Build more pipeline — known dollars still short of the gap",
      priority: "high",
      confidence: 78,
      revenueImpactCents: shortfall,
      targetCount: targets.length,
      reasoning: `Forecastable pipeline only covers about ${pct}% of what you still need this month; roughly ${formatMoneyPlain(shortfall)} is not yet represented in hard dollars. You have ${ql} qualified lead${ql === 1 ? "" : "s"} and ${tbd} deal${tbd === 1 ? "" : "s"} waiting on a clear price before they count as pipeline—set those offer amounts when you are ready so the forecast stays honest.`,
      recommendedAction:
        "Work the highest-confidence known-dollar deals first, then add one reactivation or event push to widen the top of funnel.",
      actionHref: "/opportunities",
      supportingSignals: [
        `${formatMoneyPlain(gapCents)} left to goal vs ${formatMoneyPlain(knownPipelineCents)} in forecastable pipeline`,
        `Goal progress ${Math.round(revenueSummary.goalCoveragePercent)}%`,
        "Open-house style invites do not count as pipeline dollars until priced.",
      ],
    });
  }

  // 4) lesson_package_opportunity
  if (repeatLessonSignals.length >= 2) {
    const pb =
      findPlaybook(playbooks, (p) => campaignContains(p.campaignName, /lesson|package|repeat/)) ?? playbooks[0] ?? null;
    const campaign = pb?.campaignName ?? repeatLessonSignals[0]!.recommendedCampaign;
    suggestions.push({
      id: "lesson-package-repeat-lessons",
      type: "lesson_package_opportunity",
      strand: "hidden_upsell",
      title: "Turn repeat lesson customers into packages",
      priority: "high",
      confidence: 76,
      revenueImpactCents: sumKnownPipeline(repeatLessonSignals),
      targetCount: repeatLessonSignals.length,
      reasoning:
        "Several customers are repeatedly booking lessons. A package may be a better close than another one-off booking.",
      recommendedAction:
        "Open the repeat-lesson campaign and pitch a packaged path with a clear price you stand behind.",
      actionHref: campaign ? playbookHref(campaign) : "/opportunities",
      supportingSignals: [
        `${repeatLessonSignals.length} targets with repeat lesson or high visit signals`,
      ],
      suggestedMessageAngle:
        "Since you’ve been working on your game consistently, a package may be a better fit than booking one lesson at a time.",
    });
  }

  // 5) membership_opportunity
  if (membershipCandidates.length >= 2) {
    const pb =
      findPlaybook(playbooks, (p) => campaignContains(p.campaignName, /member|membership/)) ?? playbooks[0] ?? null;
    const campaign = pb?.campaignName ?? membershipCandidates[0]!.recommendedCampaign;
    suggestions.push({
      id: "membership-repeat-non-members",
      type: "membership_opportunity",
      strand: "hidden_upsell",
      title: "Membership may be a better close for repeat non-members",
      priority: "medium",
      confidence: 72,
      revenueImpactCents: sumKnownPipeline(membershipCandidates),
      targetCount: membershipCandidates.length,
      reasoning:
        "They are already behaving like regulars. Membership can be positioned as convenience and value.",
      recommendedAction:
        "Open the membership-angled campaign, confirm they are not already members, then send one tailored membership path.",
      actionHref: campaign ? playbookHref(campaign) : "/opportunities",
      supportingSignals: [
        `${membershipCandidates.length} non-members with repeat visits or strong spend`,
      ],
      caution: "Do not pitch membership to existing members.",
      suggestedMessageAngle:
        "Since you’ve been coming in more often, membership may make booking easier and save money.",
    });
  }

  // 6) event_invite_opportunity
  if (eventSoftLeads.length >= 3) {
    suggestions.push({
      id: "event-invite-soft-reactivation",
      type: "event_invite_opportunity",
      strand: "build_pipeline",
      title: "Use a social event as a soft reactivation play",
      priority: "medium",
      confidence: 68,
      revenueImpactCents: sumKnownPipeline(eventSoftLeads),
      targetCount: eventSoftLeads.length,
      reasoning:
        "A social event invitation is lower friction than asking for a purchase immediately for lapsed or practice-heavy customers.",
      recommendedAction:
        "Pick one social or simulator night, draft a short invite list from these warmer contacts, and personally invite them.",
      actionHref: "/opportunities",
      supportingSignals: [
        `${eventSoftLeads.length} softer-intent targets (reactivation, practice, or Mailchimp)`,
      ],
      suggestedMessageAngle:
        "We’re putting together Friday night scramble-style events. Want me to send details?",
    });
  }

  // 7) junior_program_opportunity
  if (juniorSignals.length >= 1) {
    suggestions.push({
      id: "junior-program-dedicated-path",
      type: "junior_program_opportunity",
      strand: "hidden_upsell",
      title: "Junior program leads should get a dedicated path",
      priority: "medium",
      confidence: 74,
      revenueImpactCents: sumKnownPipeline(juniorSignals),
      targetCount: juniorSignals.length,
      reasoning:
        "Junior customers should not receive generic lesson or reactivation messaging. Route them to junior programming.",
      recommendedAction:
        "Open the junior-program playbook and send age-fit program details before any adult-lesson pitch.",
      actionHref: "/opportunities",
      supportingSignals: [`${juniorSignals.length} targets with junior / Whoosh / family signals`],
      suggestedMessageAngle:
        "We’re building out junior golf programs and clinics. Want me to send the next options?",
    });
  }

  // 8) open_house_opportunity
  if (reviewOnlySoft.length >= 2) {
    suggestions.push({
      id: "open-house-warm-uncertain",
      type: "open_house_opportunity",
      strand: "build_pipeline",
      title: "Use open house for uncertain warm leads",
      priority: "low",
      confidence: 64,
      revenueImpactCents: sumKnownPipeline(reviewOnlySoft),
      targetCount: reviewOnlySoft.length,
      reasoning:
        "Open house is a low-pressure way to bring uncertain leads back into the facility when SMS drafts are not ready.",
      recommendedAction:
        "Text or call each review-only contact with a simple invite to walk the space this week—no hard sell.",
      actionHref: "/opportunities",
      supportingSignals: [`${reviewOnlySoft.length} review-only targets with softer confidence`],
      suggestedMessageAngle:
        "We’re inviting people to come check out the space. Want me to send details?",
    });
  }

  // 9) hidden_upsell (practice → lesson)
  if (practiceToLesson.length >= 1) {
    const pb =
      findPlaybook(playbooks, (p) => campaignContains(p.campaignName, /practice|simulator|lesson/)) ??
      playbooks[0] ??
      null;
    const campaign = pb?.campaignName ?? practiceToLesson[0]!.recommendedCampaign;
    suggestions.push({
      id: "hidden-upsell-practice-lesson",
      type: "hidden_upsell",
      strand: "hidden_upsell",
      title: "Convert practice traffic into lesson revenue",
      priority: "medium",
      confidence: 70,
      revenueImpactCents: sumKnownPipeline(practiceToLesson),
      targetCount: practiceToLesson.length,
      reasoning:
        "Practice and simulator visits hide lesson upside. These customers already show facility intent.",
      recommendedAction:
        "Run the practice-to-lesson campaign next so simulator-heavy guests get a coaching offer before generic blasts.",
      actionHref: campaign ? playbookHref(campaign) : "/opportunities",
      supportingSignals: [`${practiceToLesson.length} practice-to-lesson targets`],
    });
  }

  // 10) do_not_prioritize
  if (bookingIntel.length > 0 && recentBuyer.length > 0) {
    suggestions.push({
      id: "do-not-lead-generic-buyer",
      type: "do_not_prioritize",
      strand: "do_not_prioritize",
      title: "Do not lead with generic recent-buyer follow-up",
      priority: "low",
      confidence: 66,
      revenueImpactCents: 0,
      targetCount: recentBuyer.length,
      reasoning:
        "Generic follow-up is less urgent than cancelled bookings, lesson rebooking, and repeat customer upsells when calendar signals are active.",
      recommendedAction:
        "Leave generic buyer blasts for later this week; finish calendar-led recovery and rebooking plays first.",
      actionHref: "/opportunities",
      supportingSignals: [
        `${bookingIntel.length} booking-intelligence targets`,
        `${recentBuyer.length} recent buyer follow-up targets`,
      ],
    });
  }

  // data_quality: thin pipeline with many mailchimp-only
  if (
    targets.length > 0 &&
    mailchimpTargets.length / targets.length > 0.65 &&
    bookingIntel.length === 0
  ) {
    suggestions.push({
      id: "data-quality-calendar-signal-thin",
      type: "data_quality",
      strand: "build_pipeline",
      title: "Calendar booking signals look thin",
      priority: "medium",
      confidence: 60,
      revenueImpactCents: 0,
      targetCount: mailchimpTargets.length,
      reasoning:
        "Most of the queue is marketing intent without fresh calendar bookings, so lesson timing plays are harder to trust.",
      recommendedAction:
        "Sync Google Calendar, let bookings populate, then refresh this list so lesson plays line up with real tee times.",
      actionHref: "/opportunities",
      supportingSignals: [`${mailchimpTargets.length} Mailchimp-led targets vs ${bookingIntel.length} booking-led`],
    });
  }

  if (suggestions.length === 0 && targets.length > 0) {
    suggestions.push({
      id: "baseline-stack-ranked-queue",
      type: "open_house_opportunity",
      strand: "build_pipeline",
      title: "Stack today’s queue before branching campaigns",
      priority: "medium",
      confidence: 55,
      revenueImpactCents: knownPipelineCents,
      targetCount: targets.length,
      reasoning:
        "No single strategic signal dominated the stack. Review the highest-score targets and pick two parallel plays.",
      recommendedAction:
        "Open Opportunities, skim the top five by score, and run two manual campaigns this afternoon—not five.",
      actionHref: "/opportunities",
      supportingSignals: [`${targets.length} eligible targets loaded`],
    });
  }

  const sorted = sortSuggestions(suggestions);
  const top = sorted.slice(0, 5);

  const pipelineShortfallCents =
    revenueSummary && revenueSummary.remainingGapCents > 0
      ? Math.max(0, revenueSummary.remainingGapCents - knownPipelineCents)
      : 0;

  const businessHeadline = buildBusinessHeadline(revenueSummary, targets.length);

  const summary =
    top.length >= 2
      ? `First: ${top[0]!.recommendedAction} Next: ${top[1]!.recommendedAction}`
      : top.length === 1
        ? `First: ${top[0]!.recommendedAction}`
        : "Once your monthly goal and queue load, your first and second moves will appear here.";

  return {
    generatedAt,
    businessHeadline,
    headline: businessHeadline,
    pipelineShortfallCents,
    summary,
    suggestions: top,
  };
}
