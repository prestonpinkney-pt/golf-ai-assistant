import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { gateBusinessUser } from "../../../lib/require-auth";
import { BUSINESS_ID } from "../../../config";

type FeedbackAction =
  | "good_target"
  | "wrong_offer"
  | "mark_member"
  | "exclude"
  | "converted"
  | "not_interested"
  | "bad_data";

type FeedbackRequestBody = {
  customerProfileId: string;
  targetingProfileId?: string | null;
  opportunityId?: string | null;
  action: FeedbackAction;
  note?: string;
  convertedRevenueCents?: number;
};

type OpportunityProfile = {
  id: string;
  customer_profile_id: string;
  targeting_profile_id: string | null;
  playbook: string | null;
  opportunity_type: string | null;
  priority: number;
  confidence: number | null;
  status: string;
};

type TargetingProfile = {
  id: string;
  customer_profile_id: string;
  recommended_playbook: string | null;
  opportunity_type: string | null;
  target_score: number;
  confidence: number | null;
};

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

function isValidAction(action: string): action is FeedbackAction {
  return [
    "good_target",
    "wrong_offer",
    "mark_member",
    "exclude",
    "converted",
    "not_interested",
    "bad_data",
  ].includes(action);
}

function getFeedbackConfig(action: FeedbackAction) {
  switch (action) {
    case "good_target":
      return {
        feedbackType: "good_target",
        actionTaken: "Operator confirmed this is a good target.",
        shouldExclude: false,
        shouldMarkMember: false,
        opportunityStatus: "open",
      };

    case "wrong_offer":
      return {
        feedbackType: "wrong_offer",
        actionTaken: "Operator said the customer is valid, but the offer is wrong.",
        shouldExclude: false,
        shouldMarkMember: false,
        opportunityStatus: "open",
      };

    case "mark_member":
      return {
        feedbackType: "mark_member",
        actionTaken: "Operator marked this customer as an existing member.",
        shouldExclude: false,
        shouldMarkMember: true,
        opportunityStatus: "open",
      };

    case "exclude":
      return {
        feedbackType: "exclude",
        actionTaken: "Operator excluded this customer from AI targeting.",
        shouldExclude: true,
        shouldMarkMember: false,
        opportunityStatus: "dismissed",
      };

    case "converted":
      return {
        feedbackType: "converted",
        actionTaken: "Operator marked this opportunity as converted.",
        shouldExclude: false,
        shouldMarkMember: false,
        opportunityStatus: "converted",
      };

    case "not_interested":
      return {
        feedbackType: "not_interested",
        actionTaken: "Customer is not interested right now.",
        shouldExclude: false,
        shouldMarkMember: false,
        opportunityStatus: "dismissed",
      };

    case "bad_data":
      return {
        feedbackType: "bad_data",
        actionTaken: "Operator flagged this recommendation as bad data.",
        shouldExclude: true,
        shouldMarkMember: false,
        opportunityStatus: "dismissed",
      };
  }
}

async function loadOpportunity(input: {
  supabase: ReturnType<typeof getSupabaseAdmin>;
  opportunityId?: string | null;
}) {
  if (!input.opportunityId) return null;

  const supabase = input.supabase as any;

  const { data, error } = await supabase
    .from("ai_opportunities")
    .select(
      "id, customer_profile_id, targeting_profile_id, playbook, opportunity_type, priority, confidence, status"
    )
    .eq("id", input.opportunityId)
    .eq("business_id", BUSINESS_ID)
    .single();

  if (error || !data) {
    return null;
  }

  return data as OpportunityProfile;
}

async function loadTargetingProfile(input: {
  supabase: ReturnType<typeof getSupabaseAdmin>;
  targetingProfileId?: string | null;
}) {
  if (!input.targetingProfileId) return null;

  const { data, error } = await input.supabase
    .from("ai_targeting_profiles")
    .select(
      "id, customer_profile_id, recommended_playbook, opportunity_type, target_score, confidence"
    )
    .eq("id", input.targetingProfileId)
    .eq("business_id", BUSINESS_ID)
    .single();

  if (error || !data) {
    return null;
  }

  return data as TargetingProfile;
}

export async function POST(request: Request) {
  try {
    const denied = await gateBusinessUser();
    if (denied) return denied;

    const body = (await request.json()) as Partial<FeedbackRequestBody>;

    if (!body.customerProfileId || !body.action) {
      return NextResponse.json(
        {
          error: "Missing required fields",
          required: ["customerProfileId", "action"],
        },
        { status: 400 }
      );
    }

    if (!body.opportunityId && !body.targetingProfileId) {
      return NextResponse.json(
        {
          error: "Missing opportunityId or targetingProfileId",
        },
        { status: 400 }
      );
    }

    if (!isValidAction(body.action)) {
      return NextResponse.json(
        {
          error: "Invalid feedback action",
        },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdmin();
    const supabaseAny = supabase as any;

    const opportunity = await loadOpportunity({
      supabase,
      opportunityId: body.opportunityId,
    });

    const targetingProfile = await loadTargetingProfile({
      supabase,
      targetingProfileId:
        body.targetingProfileId ?? opportunity?.targeting_profile_id ?? null,
    });

    if (!opportunity && !targetingProfile) {
      return NextResponse.json(
        {
          error: "Opportunity or targeting profile not found",
        },
        { status: 404 }
      );
    }

    const sourceCustomerProfileId =
      opportunity?.customer_profile_id ?? targetingProfile?.customer_profile_id;

    if (sourceCustomerProfileId !== body.customerProfileId) {
      return NextResponse.json(
        {
          error: "Customer profile does not match opportunity or targeting profile",
        },
        { status: 400 }
      );
    }

    const config = getFeedbackConfig(body.action);
    const convertedRevenueCents = Math.max(body.convertedRevenueCents ?? 0, 0);

    const playbook =
      opportunity?.playbook ?? targetingProfile?.recommended_playbook ?? null;

    const opportunityType =
      opportunity?.opportunity_type ?? targetingProfile?.opportunity_type ?? null;

    const previousScore =
      opportunity?.priority ?? targetingProfile?.target_score ?? null;

    const previousConfidence =
      opportunity?.confidence ?? targetingProfile?.confidence ?? null;

    const { error: feedbackError } = await supabase.from("ai_feedback").insert({
      business_id: BUSINESS_ID,
      customer_profile_id: body.customerProfileId,
      targeting_profile_id:
        body.targetingProfileId ?? opportunity?.targeting_profile_id ?? null,
      feedback_type: config.feedbackType,
      feedback_note: body.note ?? null,
      feedback_source: "operator",
      playbook,
      opportunity_type: opportunityType,
      previous_score: previousScore,
      previous_confidence: previousConfidence,
      action_taken: config.actionTaken,
      should_exclude: config.shouldExclude,
      should_mark_member: config.shouldMarkMember,
      converted_revenue_cents:
        body.action === "converted" ? convertedRevenueCents : 0,
      created_by: "operator",
    });

    if (feedbackError) {
      return NextResponse.json(
        {
          error: "Failed to save feedback",
          details: feedbackError.message,
        },
        { status: 500 }
      );
    }

    if (opportunity) {
      const opportunityUpdate: Record<string, unknown> = {
        status: config.opportunityStatus,
        updated_at: new Date().toISOString(),
      };

      if (
        config.opportunityStatus === "converted" ||
        config.opportunityStatus === "dismissed"
      ) {
        opportunityUpdate.closed_at = new Date().toISOString();
      }

      const { error: opportunityError } = await supabaseAny
        .from("ai_opportunities")
        .update(opportunityUpdate)
        .eq("id", opportunity.id)
        .eq("business_id", BUSINESS_ID);

      if (opportunityError) {
        return NextResponse.json(
          {
            error: "Feedback saved, but failed to update opportunity status",
            details: opportunityError.message,
          },
          { status: 500 }
        );
      }
    }

    if (body.action === "mark_member") {
      const { error: memberError } = await supabase
        .from("customer_profiles")
        .update({
          is_member: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", body.customerProfileId)
        .eq("business_id", BUSINESS_ID);

      if (memberError) {
        return NextResponse.json(
          {
            error: "Feedback saved, but failed to mark customer as member",
            details: memberError.message,
          },
          { status: 500 }
        );
      }
    }

    if (body.action === "exclude" || body.action === "bad_data") {
      const { error: excludeError } = await supabase
        .from("customer_profiles")
        .update({
          exclude_from_ai_targeting: true,
          exclusion_reason:
            body.action === "bad_data"
              ? "Bad data flagged by operator"
              : "Excluded by operator",
          updated_at: new Date().toISOString(),
        })
        .eq("id", body.customerProfileId)
        .eq("business_id", BUSINESS_ID);

      if (excludeError) {
        return NextResponse.json(
          {
            error: "Feedback saved, but failed to exclude customer",
            details: excludeError.message,
          },
          { status: 500 }
        );
      }
    }

    if (body.action === "converted") {
      const { error: outcomeError } = await supabase
        .from("campaign_outcomes")
        .insert({
          business_id: BUSINESS_ID,
          replied: true,
          booked: true,
          purchased: true,
          revenue_cents: convertedRevenueCents,
          outcome_notes:
            body.note ??
            "Operator marked this opportunity as converted from the dashboard.",
        });

      if (outcomeError) {
        return NextResponse.json(
          {
            error: "Feedback saved, but failed to save campaign outcome",
            details: outcomeError.message,
          },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      action: body.action,
      customerProfileId: body.customerProfileId,
      opportunityId: opportunity?.id ?? null,
      targetingProfileId:
        body.targetingProfileId ?? opportunity?.targeting_profile_id ?? null,
      opportunityStatus: opportunity ? config.opportunityStatus : null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to save targeting feedback",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}