import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { gateBusinessUser } from "../../lib/require-auth";
import { BUSINESS_ID, BUSINESS_SLUG } from "../../config";
import {
  buildCloseOsSalesAdvisor,
  type AdvisorRevenueSummary,
} from "../../lib/closeos-sales-advisor";
import { buildPlaybooksFromTargets } from "../../lib/closeos-playbook-engine";
import { loadOutboundOpportunityTargets } from "../../lib/opportunity-eligible-targets";

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

async function loadRevenueSummary(
  supabase: ReturnType<typeof getSupabaseAdmin>
): Promise<AdvisorRevenueSummary | null> {
  const { data, error } = await supabase
    .from("revenue_summary_current_month")
    .select(
      `
      monthly_goal_cents,
      actual_revenue_cents,
      remaining_gap_cents,
      goal_coverage_percent
    `
    )
    .eq("business_slug", BUSINESS_SLUG)
    .single();

  if (error || !data) return null;

  return {
    monthlyGoalCents: data.monthly_goal_cents,
    actualRevenueCents: data.actual_revenue_cents,
    remainingGapCents: data.remaining_gap_cents,
    goalCoveragePercent: data.goal_coverage_percent,
  };
}

/**
 * Deterministic “AI Sales Advisor” — strategic stack ranking from targets + playbooks (+ optional revenue).
 * No LLM calls; no auto-send.
 */
export async function GET() {
  try {
    const denied = await gateBusinessUser();
    if (denied) return denied;

    const supabase = getSupabaseAdmin();

    const [targets, revenueSummary] = await Promise.all([
      loadOutboundOpportunityTargets({ supabase, businessId: BUSINESS_ID }),
      loadRevenueSummary(supabase),
    ]);

    const playbooks = buildPlaybooksFromTargets(targets);
    const advisor = buildCloseOsSalesAdvisor({
      targets,
      playbooks,
      revenueSummary,
    });

    return NextResponse.json(advisor);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load sales advisor",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
