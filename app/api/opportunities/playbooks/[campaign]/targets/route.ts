import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import {
  filterTargetsByCampaignSlug,
  summarizePlaybookFromTargets,
} from "../../../../lib/closeos-playbook-engine";
import { gateBusinessUser } from "../../../../lib/require-auth";
import { loadOutboundOpportunityTargets } from "../../../../lib/opportunity-eligible-targets";
import { BUSINESS_ID } from "../../../../config";

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

export async function GET(
  request: Request,
  context: { params: Promise<{ campaign: string }> }
) {
  try {
    const denied = await gateBusinessUser();
    if (denied) return denied;

    const { campaign: campaignSlug } = await context.params;
    const { searchParams } = new URL(request.url);
    const campaignQuery = searchParams.get("campaign");

    const supabase = getSupabaseAdmin();
    const allTargets = await loadOutboundOpportunityTargets({
      supabase,
      businessId: BUSINESS_ID,
    });

    const filtered = filterTargetsByCampaignSlug(
      allTargets,
      campaignSlug,
      campaignQuery
    );

    const summary = summarizePlaybookFromTargets(
      filtered,
      campaignSlug,
      campaignQuery
    );

    return NextResponse.json({
      ...summary,
      targets: filtered,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load playbook targets",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
