import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeDaysSinceBooking,
  pickBookingContextForOpportunity,
  type BookingReservationLite,
} from "./booking-context-for-opportunity";
import { buildCloseOsAiRecommendation } from "./closeos-ai-intelligence";
import {
  effectiveOpportunityTruth,
  knownPipelineDollarsFromTruth,
} from "./closeos-opportunity-truth";
import { dedupeOpportunitiesAcrossCustomers } from "./opportunity-target-ranking";

export type CustomerProfileJoin = {
  id: string;
  external_customer_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  total_spend_cents: number;
  visit_count: number;
  last_purchase_at: string | null;
  is_member: boolean;
  exclude_from_ai_targeting: boolean;
};

export type OpportunityRowForTargets = {
  id: string;
  customer_profile_id: string | null;
  targeting_profile_id: string | null;
  recognized_opportunity: string;
  opportunity_type: string;
  playbook: string;
  status: string;
  priority: number;
  confidence: number;
  estimated_revenue_cents: number;
  revenue_review_required?: boolean | null;
  counts_toward_pipeline?: boolean | null;
  offer_key?: string | null;
  pipeline_category?: string | null;
  signal_summary: string | null;
  next_best_action: string | null;
  reply_handling_goal: string | null;
  recommended_message: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  customer_profiles: CustomerProfileJoin | CustomerProfileJoin[] | null;
  source: string | null;
};

export type OutboundOpportunityTarget = {
  id: string;
  opportunityId: string;
  targetingProfileId: string | null;
  customerProfileId: string;
  externalCustomerId: string;

  opportunitySource: string | null;
  sourceDisplayLabel: string;

  leadName: string;
  email: string | null;
  phone: string | null;
  isMember: boolean;

  totalSpendCents: number;
  visitCount: number;
  lastPurchaseAt: string | null;

  targetScore: number;
  confidence: number;
  opportunityType: string;
  estimatedRevenueCents: number;
  playbook: string;
  status: string;

  recommendedOffer: string;
  reason: string;
  recommendedMessage: string;

  recognizedOpportunity: string;
  opportunitySignalSummary: string;
  nextBestAction: string;
  replyHandlingGoal: string;

  recommendedCampaign: string;
  recommendedChannel: string;
  aiConfidenceReason: string;
  objectionHandlingNotes: string;
  followUpPlan: string;

  lastBookingAt: string | null;
  lastBookingType: string | null;
  bookingStatus: string | null;
  bookingTitle: string | null;
  daysSinceBooking: number | null;

  revenueReviewRequired: boolean;
  countsTowardPipeline: boolean;
  pipelineCategory: string;
  offerKey: string | null;
  knownPipelineContributionCents: number;

  availabilitySource: string | null;
  availabilityVerified: boolean;
};

function getCustomer(row: OpportunityRowForTargets) {
  if (Array.isArray(row.customer_profiles)) {
    return row.customer_profiles[0] ?? null;
  }
  return row.customer_profiles;
}

function normalizePhone(phone: string | null) {
  if (!phone) return null;
  const digitsOnly = phone.replace(/\D/g, "");
  if (digitsOnly.length === 10) return `+1${digitsOnly}`;
  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) {
    return `+${digitsOnly}`;
  }
  return null;
}

function hasUsablePhone(phone: string | null) {
  return Boolean(normalizePhone(phone));
}

function labelize(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function sourceDisplayLabelForOpportunity(source: string | null) {
  const s = source ?? "";
  if (s === "google_calendar_booking") return "Booking Intelligence";
  if (s === "mailchimp") return "Mailchimp Intent";
  if (s === "closeos" || s === "square") return "Purchase Signal";
  return labelize(s || "unknown");
}

function groupBookingsByCustomer(rows: BookingReservationLite[]) {
  const m = new Map<string, BookingReservationLite[]>();
  for (const r of rows) {
    if (!r.customer_profile_id) continue;
    const list = m.get(r.customer_profile_id) ?? [];
    list.push(r);
    m.set(r.customer_profile_id, list);
  }
  return m;
}

/**
 * Same eligibility, booking-aware ranking, dedupe-by-customer, and AI layer
 * as GET /api/opportunities/targets (max 50 targets after dedupe).
 */
export async function loadOutboundOpportunityTargets(input: {
  supabase: SupabaseClient;
  businessId: string;
}): Promise<OutboundOpportunityTarget[]> {
  const { supabase, businessId } = input;

  const probe = await supabase
    .from("ai_opportunities")
    .select("pipeline_category")
    .eq("business_id", businessId)
    .limit(1);

  const customerJoin =
    "customer_profiles(id,external_customer_id,first_name,last_name,email,phone,total_spend_cents,visit_count,last_purchase_at,is_member,exclude_from_ai_targeting)";

  const selectColumns =
    probe.error == null
      ? [
          "id",
          "customer_profile_id",
          "targeting_profile_id",
          "recognized_opportunity",
          "opportunity_type",
          "playbook",
          "status",
          "priority",
          "confidence",
          "estimated_revenue_cents",
          "revenue_review_required",
          "counts_toward_pipeline",
          "offer_key",
          "pipeline_category",
          "signal_summary",
          "next_best_action",
          "reply_handling_goal",
          "recommended_message",
          "metadata",
          "created_at",
          "updated_at",
          "source",
          customerJoin,
        ].join(",")
      : [
          "id",
          "customer_profile_id",
          "targeting_profile_id",
          "recognized_opportunity",
          "opportunity_type",
          "playbook",
          "status",
          "priority",
          "confidence",
          "estimated_revenue_cents",
          "signal_summary",
          "next_best_action",
          "reply_handling_goal",
          "recommended_message",
          "metadata",
          "created_at",
          "updated_at",
          "source",
          customerJoin,
        ].join(",");

  const { data, error } = await supabase
    .from("ai_opportunities")
    .select(selectColumns)
    .eq("business_id", businessId)
    .in("status", ["open", "queued"])
    .order("priority", { ascending: false })
    .limit(500);

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as unknown as OpportunityRowForTargets[];

  const filtered = rows.filter((row) => {
    if (row.recognized_opportunity === "booked_but_no_square_match") {
      return false;
    }
    if (row.pipeline_category === "data_quality") {
      return false;
    }

    const customer = getCustomer(row);
    if (!customer) return false;
    if (!row.customer_profile_id) return false;
    if (customer.exclude_from_ai_targeting) return false;

    const isMailchimpLead =
      row.source === "mailchimp" ||
      row.playbook.includes("lead-follow-up") ||
      row.playbook.includes("clinic-follow-up") ||
      row.playbook.includes("junior-program-follow-up") ||
      row.playbook.includes("customer-reactivation") ||
      row.recognized_opportunity.startsWith("mailchimp_");

    const isBookingIntel = row.source === "google_calendar_booking";
    const isWhooshAvailability = row.source === "whoosh_availability";

    if (customer.total_spend_cents <= 0 && !isMailchimpLead && !isBookingIntel && !isWhooshAvailability) {
      return false;
    }
    if (!hasUsablePhone(customer.phone)) return false;

    return true;
  });

  const deduped = dedupeOpportunitiesAcrossCustomers(filtered).slice(0, 50);

  const customerIds = [
    ...new Set(
      deduped
        .map((r) => r.customer_profile_id)
        .filter((id): id is string => Boolean(id))
    ),
  ];

  let bookingsByCustomer = new Map<string, BookingReservationLite[]>();

  if (customerIds.length > 0) {
    const { data: bookingData, error: bookingError } = await supabase
      .from("booking_reservations")
      .select(
        "customer_profile_id, reservation_type, status, starts_at, ends_at, title"
      )
      .eq("business_id", businessId)
      .eq("source", "google_calendar")
      .in("customer_profile_id", customerIds)
      .order("starts_at", { ascending: false });

    if (!bookingError && bookingData) {
      bookingsByCustomer = groupBookingsByCustomer(
        bookingData as BookingReservationLite[]
      );
    }
  }

  return deduped
    .map((row) => {
      const customer = getCustomer(row);
      if (!customer || !row.customer_profile_id) return null;

      const normalizedPhone = normalizePhone(customer.phone);
      if (!normalizedPhone) return null;

      const fullName = [customer.first_name, customer.last_name]
        .filter(Boolean)
        .join(" ");
      const leadName = fullName || customer.email || normalizedPhone;

      const customerBookings =
        bookingsByCustomer.get(row.customer_profile_id) ?? [];

      const bookingRow = pickBookingContextForOpportunity({
        recognizedOpportunity: row.recognized_opportunity,
        opportunitySource: row.source,
        customerBookings,
      });

      const daysSinceBooking = computeDaysSinceBooking(bookingRow);

      const eff = effectiveOpportunityTruth({
        recognized_opportunity: row.recognized_opportunity,
        pipeline_category: row.pipeline_category ?? null,
        counts_toward_pipeline: row.counts_toward_pipeline ?? null,
        revenue_review_required: row.revenue_review_required ?? null,
        offer_key: row.offer_key ?? null,
        estimated_revenue_cents: row.estimated_revenue_cents,
      });
      const knownPipelineContributionCents =
        knownPipelineDollarsFromTruth(eff);

      const meta =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};
      const availabilitySource =
        typeof meta.availability_source === "string" ? meta.availability_source : null;
      const availabilityVerified = meta.availability_verified === true;
      const suggestedDayparts = Array.isArray(meta.suggested_dayparts)
        ? meta.suggested_dayparts.filter((d): d is string => typeof d === "string")
        : [];
      const whooshDaypart =
        suggestedDayparts.includes("sunday")
          ? ("sunday" as const)
          : suggestedDayparts.includes("weekday")
            ? ("weekday" as const)
            : ("general" as const);

      const ai = buildCloseOsAiRecommendation({
        opportunity: {
          id: row.id,
          recognized_opportunity: row.recognized_opportunity,
          playbook: row.playbook,
          opportunity_type: row.opportunity_type,
          source: row.source,
          confidence: row.confidence,
          estimated_revenue_cents: eff.storedEstimatedCents,
          signal_summary: row.signal_summary,
          next_best_action: row.next_best_action,
          reply_handling_goal: row.reply_handling_goal,
          recommended_message: row.recommended_message,
        },
        whooshAvailability:
          availabilityVerified
            ? {
                verified: true,
                hasExactTimes: false,
                daypart: whooshDaypart,
              }
            : null,
        customer: {
          first_name: customer.first_name,
          last_name: customer.last_name,
          leadName,
          email: customer.email,
          phone: normalizedPhone,
          is_member: customer.is_member,
          total_spend_cents: customer.total_spend_cents,
          visit_count: customer.visit_count,
          last_purchase_at: customer.last_purchase_at,
        },
        bookingContext: bookingRow
          ? {
              bookingTitle: bookingRow.title,
              bookingStatus: bookingRow.status,
              reservationType: bookingRow.reservation_type,
              lastBookingAt:
                bookingRow.starts_at ?? bookingRow.ends_at ?? null,
              daysSinceBooking,
            }
          : null,
        sourceDisplayLabel: sourceDisplayLabelForOpportunity(row.source),
      });

      const target: OutboundOpportunityTarget = {
        id: row.id,
        opportunityId: row.id,
        targetingProfileId: row.targeting_profile_id,
        customerProfileId: customer.id,
        externalCustomerId: customer.external_customer_id,

        opportunitySource: row.source,
        sourceDisplayLabel: sourceDisplayLabelForOpportunity(row.source),

        leadName,
        email: customer.email,
        phone: normalizedPhone,
        isMember: customer.is_member,

        totalSpendCents: customer.total_spend_cents,
        visitCount: customer.visit_count,
        lastPurchaseAt: customer.last_purchase_at,

        targetScore: row.priority,
        confidence: row.confidence,
        opportunityType: row.opportunity_type,
        estimatedRevenueCents: eff.storedEstimatedCents,
        playbook: row.playbook,
        status: row.status,

        recommendedOffer: ai.recommendedOffer,
        reason: ai.aiOpportunityReason,
        recommendedMessage: ai.recommendedMessage,

        recognizedOpportunity: row.recognized_opportunity,
        opportunitySignalSummary:
          row.signal_summary ??
          "CloseOS recognized this as an actionable revenue opportunity.",
        nextBestAction: ai.nextBestAction,
        replyHandlingGoal: ai.replyHandlingGoal,

        recommendedCampaign: ai.recommendedCampaign,
        recommendedChannel: ai.recommendedChannel,
        aiConfidenceReason: ai.aiConfidenceReason,
        objectionHandlingNotes: ai.objectionHandlingNotes,
        followUpPlan: ai.followUpPlan,

        lastBookingAt: bookingRow?.starts_at ?? bookingRow?.ends_at ?? null,
        lastBookingType: bookingRow?.reservation_type ?? null,
        bookingStatus: bookingRow?.status ?? null,
        bookingTitle: bookingRow?.title ?? null,
        daysSinceBooking,

        revenueReviewRequired: eff.revenueReviewRequired,
        countsTowardPipeline: eff.countsTowardPipeline,
        pipelineCategory: eff.pipelineCategory,
        offerKey: eff.offerKey,
        knownPipelineContributionCents,
        availabilitySource,
        availabilityVerified,
      };
      return target;
    })
    .filter((t): t is OutboundOpportunityTarget => t !== null);
}
