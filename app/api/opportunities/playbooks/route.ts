import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { buildPlaybooksFromTargets } from "../../lib/closeos-playbook-engine";
import { gateBusinessUser } from "../../lib/require-auth";
import { loadOutboundOpportunityTargets } from "../../lib/opportunity-eligible-targets";
import { BUSINESS_ID } from "../../config";

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

/**
 * Campaign-level rollup of the same eligible targets as GET /api/opportunities/targets,
 * grouped by deterministic recommendedCampaign (CloseOS AI intelligence).
 */
export async function GET() {
  try {
    const denied = await gateBusinessUser();
    if (denied) return denied;

    const supabase = getSupabaseAdmin();
    const targets = await loadOutboundOpportunityTargets({
      supabase,
      businessId: BUSINESS_ID,
    });

    const playbooks = buildPlaybooksFromTargets(targets);

    return NextResponse.json({
      playbooks,
      totalTargets: targets.length,
      rankingMode: "urgency_revenue_confidence_count_source",
      contactRequirement: "valid_phone_required",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load opportunity playbooks",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
