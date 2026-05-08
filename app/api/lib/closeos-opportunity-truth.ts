import { CLOSEOS_BUSINESS_OFFERS } from "./closeos-business-offers";

export type PipelineCategory =
  | "known_pipeline"
  | "qualified_lead"
  | "review_only"
  | "data_quality";

export type OpportunityTruth = {
  offerKey: string | null;
  estimatedRevenueCents: number;
  revenueReviewRequired: boolean;
  countsTowardPipeline: boolean;
  pipelineCategory: PipelineCategory;
};

function offerCents(key: keyof typeof CLOSEOS_BUSINESS_OFFERS): number {
  const o = CLOSEOS_BUSINESS_OFFERS[key];
  const v = "estimatedRevenueCents" in o ? o.estimatedRevenueCents : null;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function offerReview(key: keyof typeof CLOSEOS_BUSINESS_OFFERS): boolean {
  const o = CLOSEOS_BUSINESS_OFFERS[key];
  return "revenueReviewRequired" in o && Boolean(o.revenueReviewRequired);
}

function offerCountsPipeline(key: keyof typeof CLOSEOS_BUSINESS_OFFERS): boolean {
  const o = CLOSEOS_BUSINESS_OFFERS[key];
  return "countsTowardPipeline" in o ? Boolean(o.countsTowardPipeline) : false;
}

/**
 * When an offer is configured with a positive amount and explicitly counts toward pipeline,
 * opportunities tied to that offer become known_pipeline dollars.
 */
function configuredKnownPipelineForOfferKey(
  key: keyof typeof CLOSEOS_BUSINESS_OFFERS
): OpportunityTruth | null {
  const o = CLOSEOS_BUSINESS_OFFERS[key];
  const centsRaw =
    "estimatedRevenueCents" in o ? o.estimatedRevenueCents : null;
  const cents =
    typeof centsRaw === "number" && Number.isFinite(centsRaw) ? centsRaw : 0;
  const counts =
    "countsTowardPipeline" in o ? Boolean(o.countsTowardPipeline) : false;
  const review =
    "revenueReviewRequired" in o ? Boolean(o.revenueReviewRequired) : false;
  if (cents > 0 && counts && !review) {
    return {
      offerKey: key,
      estimatedRevenueCents: cents,
      revenueReviewRequired: false,
      countsTowardPipeline: true,
      pipelineCategory: "known_pipeline",
    };
  }
  return null;
}

function qualifiedLeadFromOfferKey(
  key: keyof typeof CLOSEOS_BUSINESS_OFFERS
): OpportunityTruth {
  return {
    offerKey: key,
    estimatedRevenueCents: 0,
    revenueReviewRequired: true,
    countsTowardPipeline: false,
    pipelineCategory: "qualified_lead",
  };
}

/** Canonical classification for ai_opportunities + UI. */
export function getOpportunityTruthForRecognized(
  recognizedOpportunity: string
): OpportunityTruth {
  const ro = recognizedOpportunity;

  if (ro === "booked_but_no_square_match") {
    return {
      offerKey: null,
      estimatedRevenueCents: 0,
      revenueReviewRequired: false,
      countsTowardPipeline: false,
      pipelineCategory: "data_quality",
    };
  }

  if (ro === "booking_cancelled_recovery") {
    const k = "cancelledLessonRecovery" as const;
    return {
      offerKey: k,
      estimatedRevenueCents: offerCents(k),
      revenueReviewRequired: offerReview(k),
      countsTowardPipeline: offerCountsPipeline(k),
      pipelineCategory: "known_pipeline",
    };
  }

  if (ro === "lesson_rebooking_due" || ro === "member_lesson_rebooking") {
    const k = "privateLesson" as const;
    return {
      offerKey: k,
      estimatedRevenueCents: offerCents(k),
      revenueReviewRequired: false,
      countsTowardPipeline: true,
      pipelineCategory: "known_pipeline",
    };
  }

  if (ro === "practice_to_lesson") {
    const k = "privateLesson" as const;
    return {
      offerKey: k,
      estimatedRevenueCents: offerCents(k),
      revenueReviewRequired: false,
      countsTowardPipeline: true,
      pipelineCategory: "known_pipeline",
    };
  }

  if (ro === "lesson_package_candidate") {
    const k = "lessonPackage" as const;
    return configuredKnownPipelineForOfferKey(k) ?? qualifiedLeadFromOfferKey(k);
  }

  if (
    ro === "membership_conversion_candidate" ||
    ro === "repeat_guest_to_member"
  ) {
    const k = "membership" as const;
    return configuredKnownPipelineForOfferKey(k) ?? qualifiedLeadFromOfferKey(k);
  }

  if (
    ro === "private_event_booking_candidate" ||
    ro === "event_rebooking" ||
    ro === "event_follow_up"
  ) {
    const k = "privateEvent" as const;
    return configuredKnownPipelineForOfferKey(k) ?? qualifiedLeadFromOfferKey(k);
  }

  if (
    ro === "junior_program_candidate" ||
    ro === "junior_program_follow_up"
  ) {
    const k = "juniorProgram" as const;
    return configuredKnownPipelineForOfferKey(k) ?? qualifiedLeadFromOfferKey(k);
  }

  if (
    ro === "clinic_invite" ||
    ro === "clinic_follow_up" ||
    ro === "clinic_progression"
  ) {
    const k = "clinic" as const;
    return configuredKnownPipelineForOfferKey(k) ?? qualifiedLeadFromOfferKey(k);
  }

  if (ro === "friday_scramble_invite") {
    const k = "fridayScramble" as const;
    return configuredKnownPipelineForOfferKey(k) ?? qualifiedLeadFromOfferKey(k);
  }

  if (ro === "open_house_invite") {
    const k = "openHouse" as const;
    return {
      offerKey: k,
      estimatedRevenueCents: 0,
      revenueReviewRequired: false,
      countsTowardPipeline: false,
      pipelineCategory: "qualified_lead",
    };
  }

  if (ro.startsWith("mailchimp_")) {
    return {
      offerKey: null,
      estimatedRevenueCents: 0,
      revenueReviewRequired: true,
      countsTowardPipeline: false,
      pipelineCategory: "qualified_lead",
    };
  }

  if (ro === "inactive_customer_reactivation" || ro === "recent_buyer_follow_up") {
    return {
      offerKey: null,
      estimatedRevenueCents: 0,
      revenueReviewRequired: true,
      countsTowardPipeline: false,
      pipelineCategory: "qualified_lead",
    };
  }

  return {
    offerKey: null,
    estimatedRevenueCents: 0,
    revenueReviewRequired: true,
    countsTowardPipeline: false,
    pipelineCategory: "qualified_lead",
  };
}

/** DB snake_case fields for inserts/updates. */
export function truthFieldsForDb(recognizedOpportunity: string) {
  const t = getOpportunityTruthForRecognized(recognizedOpportunity);
  return {
    offer_key: t.offerKey,
    estimated_revenue_cents: t.estimatedRevenueCents,
    revenue_review_required: t.revenueReviewRequired,
    counts_toward_pipeline: t.countsTowardPipeline,
    pipeline_category: t.pipelineCategory,
  };
}

/**
 * Merge stored row with canonical truth when legacy rows predate columns.
 */
export function effectiveOpportunityTruth(input: {
  recognized_opportunity: string;
  pipeline_category?: string | null;
  counts_toward_pipeline?: boolean | null;
  revenue_review_required?: boolean | null;
  offer_key?: string | null;
  estimated_revenue_cents?: number | null;
}): OpportunityTruth & { storedEstimatedCents: number } {
  const canonical = getOpportunityTruthForRecognized(input.recognized_opportunity);
  const hasPipelineCat = Boolean(input.pipeline_category?.trim());
  const rawStored = Number(input.estimated_revenue_cents ?? 0) || 0;

  if (!hasPipelineCat) {
    return {
      ...canonical,
      storedEstimatedCents: canonical.estimatedRevenueCents,
    };
  }

  return {
    offerKey: input.offer_key ?? canonical.offerKey,
    estimatedRevenueCents: rawStored,
    revenueReviewRequired:
      input.revenue_review_required ?? canonical.revenueReviewRequired,
    countsTowardPipeline:
      input.counts_toward_pipeline ?? canonical.countsTowardPipeline,
    pipelineCategory: (input.pipeline_category ??
      canonical.pipelineCategory) as PipelineCategory,
    storedEstimatedCents: rawStored,
  };
}

export function knownPipelineDollarsFromTruth(
  eff: OpportunityTruth & { storedEstimatedCents: number }
): number {
  if (eff.pipelineCategory !== "known_pipeline") return 0;
  if (!eff.countsTowardPipeline) return 0;
  if (eff.revenueReviewRequired) return 0;
  const v = eff.storedEstimatedCents;
  return v > 0 ? v : 0;
}
