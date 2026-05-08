/**
 * CloseOS offer truth — configured dollar amounts only.
 * Unknown-price offers stay visible as qualified leads / TBD, not pipeline dollars.
 * To count an offer toward known pipeline, set estimatedRevenueCents and countsTowardPipeline: true.
 *
 * Admin: membership, lesson packages, private events, clinics, junior programs, and Friday scrambles
 * only roll into **known pipeline dollars** after you set a positive `estimatedRevenueCents` and
 * `countsTowardPipeline: true` (and clear `revenueReviewRequired`). Example:
 *   lessonPackage.estimatedRevenueCents = 60000; lessonPackage.countsTowardPipeline = true;
 *   membership.estimatedRevenueCents = 100000; membership.countsTowardPipeline = true;
 *   privateEvent.estimatedRevenueCents = 150000; privateEvent.countsTowardPipeline = true;
 * Until then, CloseOS classifies those opportunities as qualified leads with revenue TBD, not pipeline $.
 */
export const CLOSEOS_BUSINESS_OFFERS = {
  privateLesson: {
    enabled: true,
    offerName: "Private Lesson",
    estimatedRevenueCents: 15000 as number,
    countsTowardPipeline: true,
  },
  cancelledLessonRecovery: {
    enabled: true,
    offerName: "Cancelled Lesson Recovery",
    estimatedRevenueCents: 15000 as number,
    countsTowardPipeline: true,
  },
  lessonPackage: {
    enabled: true,
    offerName: "Lesson Package",
    estimatedRevenueCents: null as number | null,
    countsTowardPipeline: false,
    revenueReviewRequired: true,
  },
  membership: {
    enabled: true,
    offerName: "Primetime Membership",
    estimatedRevenueCents: null as number | null,
    countsTowardPipeline: false,
    revenueReviewRequired: true,
  },
  privateEvent: {
    enabled: true,
    offerName: "Private Event",
    estimatedRevenueCents: null as number | null,
    countsTowardPipeline: false,
    revenueReviewRequired: true,
  },
  juniorProgram: {
    enabled: true,
    offerName: "Junior Golf Program",
    estimatedRevenueCents: null as number | null,
    countsTowardPipeline: false,
    revenueReviewRequired: true,
  },
  clinic: {
    enabled: true,
    offerName: "Clinic",
    estimatedRevenueCents: null as number | null,
    countsTowardPipeline: false,
    revenueReviewRequired: true,
  },
  fridayScramble: {
    enabled: true,
    offerName: "Friday Night Scramble",
    estimatedRevenueCents: null as number | null,
    countsTowardPipeline: false,
    revenueReviewRequired: true,
  },
  openHouse: {
    enabled: true,
    offerName: "Open House",
    estimatedRevenueCents: 0 as number,
    countsTowardPipeline: false,
  },
} as const;

export type CloseOsOfferKey = keyof typeof CLOSEOS_BUSINESS_OFFERS;
