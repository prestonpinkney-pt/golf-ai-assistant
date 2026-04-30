import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
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
    auth: {
      persistSession: false,
    },
  });
}

export async function GET() {
  try {
    const denied = await gateBusinessUser();
    if (denied) return denied;

    const supabase = getSupabaseAdmin();

    const targets = await loadOutboundOpportunityTargets({
      supabase,
      businessId: BUSINESS_ID,
    });

    return NextResponse.json({
      targets,
      contactRequirement: "valid_phone_required",
      totalReturned: targets.length,
      rankingMode: "booking_aware_deduped_by_customer",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load opportunity targets",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
