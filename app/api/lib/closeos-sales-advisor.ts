import type { CloseOsPlaybookSummary } from "./closeos-playbook-engine";
import { slugifyCampaignName } from "./closeos-playbook-engine";
import type { OutboundOpportunityTarget } from "./opportunity-eligible-targets";

export type AdvisorRevenueSummary = {
  monthlyGoalCents: number;
  actualRevenueCents: number;
  remainingGapCents: number;
  goalCoveragePercent: number;
};

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
  title: string;
  priority: AdvisorSuggestionPriority;
  confidence: number;
  revenueImpactCents: number;
  targetCount: number;
  reasoning: string;
  recommendedAction: string;
  actionHref: string | null;
  supportingSignals: string[];
  caution?: string;
  suggestedMessageAngle?: string;
};

export type CloseOsSalesAdvisorResult = {
  generatedAt: string;
  headline: string;
  summary: string;
  suggestions: AdvisorSuggestion[];
};

export type BuildCloseOsSalesAdvisorInput = {
  targets: OutboundOpportunityTarget[];
  playbooks: CloseOsPlaybookSummary[];
  revenueSummary: AdvisorRevenueSummary | null;
};

function sumRevenue(ts: OutboundOpportunityTarget[]) {
  return ts.reduce((s, t) => s + t.estimatedRevenueCents, 0);
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

  const pipelineCents = sumRevenue(targets);
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
      title: "Start with cancelled lesson recovery",
      priority: "critical",
      confidence: 88,
      revenueImpactCents: sumRevenue(cancelledRecovery),
      targetCount: cancelledRecovery.length,
      reasoning:
        "These customers already tried to book lessons and cancelled without a replacement. They are warmer than cold leads.",
      recommendedAction: "Review and recover cancelled lesson bookings first.",
      actionHref: campaign ? playbookHref(campaign) : "/opportunities",
      supportingSignals: [
        `${cancelledRecovery.length} reachable targets tied to cancelled or recovery signals`,
        bookingIntel.length > 0 ? "Booking Intelligence is live in the mix" : "Calendar-backed signals present",
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
      title: "Review unmatched booking identities",
      priority: "critical",
      confidence: 82,
      revenueImpactCents: sumRevenue(identityGap),
      targetCount: identityGap.length,
      reasoning:
        "Some lesson bookings have names but are not safely attached to reachable Square profiles. Clean matches before outreach.",
      recommendedAction: "Resolve identity matches in Opportunities before sending.",
      actionHref: "/opportunities",
      supportingSignals: [`${identityGap.length} targets flagged booked_but_no_square_match`],
      caution: "Do not auto-text until identity is confirmed.",
    });
  }

  // 3) pipeline_gap
  if (revenueSummary && gapCents > 0 && pipelineCents < gapCents) {
    const pct = Math.round((pipelineCents / gapCents) * 100);
    suggestions.push({
      id: "pipeline-gap-monthly-goal",
      type: "pipeline_gap",
      title: "Current pipeline does not cover the goal",
      priority: "high",
      confidence: 78,
      revenueImpactCents: Math.max(0, gapCents - pipelineCents),
      targetCount: targets.length,
      reasoning: `Even if every open opportunity closed at full estimate, you still need more pipeline. Open pipeline covers about ${pct}% of the remaining gap.`,
      recommendedAction: "Layer reactivation and event invites while you close booking plays.",
      actionHref: "/opportunities",
      supportingSignals: [
        `Gap ${(gapCents / 100).toFixed(0)} vs pipeline ${(pipelineCents / 100).toFixed(0)}`,
        `Goal progress ${Math.round(revenueSummary.goalCoveragePercent)}%`,
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
      title: "Turn repeat lesson customers into packages",
      priority: "high",
      confidence: 76,
      revenueImpactCents: sumRevenue(repeatLessonSignals),
      targetCount: repeatLessonSignals.length,
      reasoning:
        "Several customers are repeatedly booking lessons. A package may be a better close than another one-off booking.",
      recommendedAction: "Offer lesson package options to repeat lesson customers.",
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
      title: "Membership may be a better close for repeat non-members",
      priority: "medium",
      confidence: 72,
      revenueImpactCents: sumRevenue(membershipCandidates),
      targetCount: membershipCandidates.length,
      reasoning:
        "They are already behaving like regulars. Membership can be positioned as convenience and value.",
      recommendedAction: "Pitch membership after confirming they are not already members.",
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
      title: "Use a Friday-style scramble as a soft reactivation play",
      priority: "medium",
      confidence: 68,
      revenueImpactCents: sumRevenue(eventSoftLeads),
      targetCount: eventSoftLeads.length,
      reasoning:
        "A social event invitation is lower friction than asking for a purchase immediately for lapsed or practice-heavy customers.",
      recommendedAction: "Invite warm-but-uncertain leads to a social round or simulator night.",
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
      title: "Junior program leads should get a dedicated path",
      priority: "medium",
      confidence: 74,
      revenueImpactCents: sumRevenue(juniorSignals),
      targetCount: juniorSignals.length,
      reasoning:
        "Junior customers should not receive generic lesson or reactivation messaging. Route them to junior programming.",
      recommendedAction: "Segment junior leads before sending adult lesson copy.",
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
      title: "Use open house for uncertain warm leads",
      priority: "low",
      confidence: 64,
      revenueImpactCents: sumRevenue(reviewOnlySoft),
      targetCount: reviewOnlySoft.length,
      reasoning:
        "Open house is a low-pressure way to bring uncertain leads back into the facility when SMS drafts are not ready.",
      recommendedAction: "Invite review-only leads to an open house or walk-through.",
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
      title: "Convert practice traffic into lesson revenue",
      priority: "medium",
      confidence: 70,
      revenueImpactCents: sumRevenue(practiceToLesson),
      targetCount: practiceToLesson.length,
      reasoning:
        "Practice and simulator visits hide lesson upside. These customers already show facility intent.",
      recommendedAction: "Pair practice-to-lesson plays before broad buyer blasts.",
      actionHref: campaign ? playbookHref(campaign) : "/opportunities",
      supportingSignals: [`${practiceToLesson.length} practice-to-lesson targets`],
    });
  }

  // 10) do_not_prioritize
  if (bookingIntel.length > 0 && recentBuyer.length > 0) {
    suggestions.push({
      id: "do-not-lead-generic-buyer",
      type: "do_not_prioritize",
      title: "Do not lead with generic recent buyer follow-up",
      priority: "low",
      confidence: 66,
      revenueImpactCents: 0,
      targetCount: recentBuyer.length,
      reasoning:
        "Generic follow-up is less urgent than cancelled bookings, lesson rebooking, and repeat customer upsells when Booking Intelligence is active.",
      recommendedAction: "Run booking and upsell plays first.",
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
      title: "Calendar booking signals look thin",
      priority: "medium",
      confidence: 60,
      revenueImpactCents: 0,
      targetCount: mailchimpTargets.length,
      reasoning:
        "Most open opportunities are Mailchimp intent without fresh calendar bookings. Calendar sync will sharpen lesson plays.",
      recommendedAction: "Sync Google Calendar and re-run opportunities after bookings update.",
      actionHref: "/opportunities",
      supportingSignals: [`${mailchimpTargets.length} Mailchimp-led targets vs ${bookingIntel.length} booking-led`],
    });
  }

  if (suggestions.length === 0 && targets.length > 0) {
    suggestions.push({
      id: "baseline-stack-ranked-queue",
      type: "open_house_opportunity",
      title: "Stack today’s queue before branching campaigns",
      priority: "medium",
      confidence: 55,
      revenueImpactCents: pipelineCents,
      targetCount: targets.length,
      reasoning:
        "No single strategic signal dominated the stack. Review the highest-score targets and pick two parallel plays.",
      recommendedAction: "Open Opportunities, sort by score, and run the top two campaigns manually.",
      actionHref: "/opportunities",
      supportingSignals: [`${targets.length} eligible targets loaded`],
    });
  }

  const sorted = sortSuggestions(suggestions);
  const top = sorted.slice(0, 8);

  const headline =
    top[0]?.title ??
    (targets.length === 0 ? "Load opportunities to get seller guidance" : "Review opportunities to unlock plays");

  const summaryParts: string[] = [];
  if (top[0]) summaryParts.push(top[0].recommendedAction);
  if (top[1]) summaryParts.push(top[1].title + ": " + top[1].recommendedAction);
  const summary =
    summaryParts.slice(0, 2).join(" ") ||
    "CloseOS will propose plays once targets and revenue signals are available.";

  return {
    generatedAt,
    headline,
    summary,
    suggestions: top,
  };
}
