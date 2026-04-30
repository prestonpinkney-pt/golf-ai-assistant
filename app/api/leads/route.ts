import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { toInboxLead } from "./_shared";

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from("leads")
      .select(
        "id, full_name, phone, email, message, source, lead_type, status, follow_up_count, preferred_contact_channel, last_contacted_at, created_at, ai_summary, ai_next_best_action, ai_last_reasoning"
      )
      .order("created_at", { ascending: false })
      .limit(250);

    if (error) {
      return NextResponse.json(
        { error: error.message || "Failed to load leads" },
        { status: 500 }
      );
    }

    return NextResponse.json((data ?? []).map(toInboxLead));
  } catch (error: any) {
    console.error("Read leads error:", error);

    return NextResponse.json(
      { error: error?.message || "Failed to load leads" },
      { status: 500 }
    );
  }
}