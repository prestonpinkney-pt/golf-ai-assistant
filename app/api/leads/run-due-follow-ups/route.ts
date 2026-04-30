import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

function getNextFollowUpDate(hoursFromNow: number) {
  const date = new Date();
  date.setHours(date.getHours() + hoursFromNow);
  return date.toISOString();
}

function buildFollowUpMessage(lead: any) {
  const intent = lead.primaryIntent;

  if (intent === "lesson") {
    return "Just following up — I can still help you get a lesson lined up. Want me to help you lock in a time?";
  }

  if (intent === "event") {
    return "Following up on your event inquiry — if you send over the date and group details, I can help move it in the right direction.";
  }

  if (intent === "tee_time") {
    return "Quick follow-up — if you're still looking for a tee time, send me the day and time window you want.";
  }

  if (intent === "membership") {
    return "Following up — if you're still looking at membership options, I can help point you toward the best fit.";
  }

  return "Just following up — if you still want help, send me a little more detail and I’ll keep it moving.";
}

export async function POST() {
  try {
    const { data: leads, error } = await supabaseAdmin
      .from("leads")
      .select("id, lead_type, status, follow_up_count")
      .in("status", ["open", "contacted", "new"])
      .order("created_at", { ascending: true })
      .limit(100);

    if (error) {
      return NextResponse.json(
        { error: error.message || "Failed to load due leads" },
        { status: 500 }
      );
    }

    let processedCount = 0;
    const nowIso = new Date().toISOString();

    for (const lead of leads ?? []) {
      const followUpMessage = buildFollowUpMessage({
        primaryIntent: lead.lead_type,
      });
      const newCount = (lead.follow_up_count ?? 0) + 1;
      const nextFollowUpAt =
        newCount >= 2 ? null : `Follow up after ${getNextFollowUpDate(24)}`;

      const { error: updateError } = await supabaseAdmin
        .from("leads")
        .update({
          follow_up_count: newCount,
          last_contacted_at: nowIso,
          status:
            lead.status === "open" || lead.status === "new"
              ? "contacted"
              : lead.status,
          ai_next_best_action: nextFollowUpAt,
          ai_summary: followUpMessage,
        })
        .eq("id", lead.id);

      if (!updateError) {
        processedCount += 1;
      }
    }

    return NextResponse.json({
      success: true,
      processedCount,
    });
  } catch (error: any) {
    console.error("Run due follow-ups error:", error);

    return NextResponse.json(
      { error: error?.message || "Failed to run due follow-ups" },
      { status: 500 }
    );
  }
}