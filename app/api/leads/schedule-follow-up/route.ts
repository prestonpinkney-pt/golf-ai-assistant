import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { gateBusinessUser } from "../../lib/require-auth";

function getFutureISO(hoursFromNow: number) {
  const d = new Date();
  d.setHours(d.getHours() + hoursFromNow);
  return d.toISOString();
}

export async function POST(req: Request) {
  const denied = await gateBusinessUser();
  if (denied) return denied;

  try {
    const body = await req.json();
    const { id, channel, hoursFromNow } = body;

    if (!id) {
      return NextResponse.json(
        { error: "Lead id is required" },
        { status: 400 }
      );
    }

    const nextFollowUpAt = getFutureISO(
      typeof hoursFromNow === "number" ? hoursFromNow : 24
    );

    const { data: updatedLead, error } = await supabaseAdmin
      .from("leads")
      .update({
        preferred_contact_channel: channel || "sms",
        ai_next_best_action: `Follow up after ${nextFollowUpAt}`,
      })
      .eq("id", id)
      .select("id")
      .single();

    if (error || !updatedLead) {
      return NextResponse.json(
        { error: error?.message || "Lead not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      lead: updatedLead,
    });
  } catch (error: any) {
    console.error("Schedule follow-up error:", error);

    return NextResponse.json(
      { error: error?.message || "Failed to schedule follow-up" },
      { status: 500 }
    );
  }
}