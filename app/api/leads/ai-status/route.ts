import { NextResponse } from "next/server";
import OpenAI from "openai";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchLeadById } from "../_shared";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json(
        { error: "Lead id is required" },
        { status: 400 }
      );
    }

    const lead = await fetchLeadById(id);

    if (!lead) {
      return NextResponse.json(
        { error: "Lead not found" },
        { status: 404 }
      );
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You classify lead status. Return only JSON.",
        },
        {
          role: "user",
          content: `
Message: ${lead.message ?? ""}
Reply: ${lead.ai_next_best_action ?? ""}
Intent: ${lead.lead_type ?? "general"}
Follow-ups: ${lead.follow_up_count ?? 0}
Current Status: ${lead.status ?? "open"}

Pick one:
open, contacted, booked, closed

Return:
{ "status": "", "reason": "" }
`,
        },
      ],
    });

    const raw = completion.choices[0].message.content || "{}";
    const parsed = JSON.parse(raw);
    const { error } = await supabaseAdmin
      .from("leads")
      .update({
        status: parsed.status || lead.status,
        ai_last_reasoning: parsed.reason || "",
      })
      .eq("id", id);

    if (error) {
      return NextResponse.json(
        { error: error.message || "Failed to save AI status" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
}