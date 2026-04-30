import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { gateBusinessUser } from "../../lib/require-auth";
import { BUSINESS_SLUG } from "../../config";

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

export async function GET() {
  const denied = await gateBusinessUser();
  if (denied) return denied;

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("revenue_summary_current_month")
    .select(
      `
      business_id,
      business_name,
      business_slug,
      monthly_goal_cents,
      actual_revenue_cents,
      remaining_gap_cents,
      goal_coverage_percent
    `
    )
    .eq("business_slug", BUSINESS_SLUG)
    .single();

  if (error || !data) {
    return NextResponse.json(
      {
        error: "Failed to load revenue summary",
        details: error?.message,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    businessId: data.business_id,
    businessName: data.business_name,
    businessSlug: data.business_slug,
    monthlyGoalCents: data.monthly_goal_cents,
    actualRevenueCents: data.actual_revenue_cents,
    remainingGapCents: data.remaining_gap_cents,
    goalCoveragePercent: data.goal_coverage_percent,
  });
}