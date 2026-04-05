import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabase/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log("Incoming body:", body);

    const { name, phone, email, message } = body;

    if (!name || !phone || !email || !message) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const { data: site, error: siteError } = await supabaseAdmin
      .from("sites")
      .select("id, name, domain")
      .eq("domain", "primetimegolf.org")
      .single();

    console.log("Site result:", site);
    console.log("Site error:", siteError);

    if (siteError || !site) {
      return NextResponse.json(
        { error: "Site not found", details: siteError },
        { status: 500 }
      );
    }

    const insertPayload = {
      site_id: site.id,
      full_name: name,
      phone,
      email,
      message,
      source: "website_form",
      lead_type: "lesson",
      status: "new",
      temperature: "warm",
      priority: "medium",
      stage: "new_inquiry",
      preferred_contact_channel: "sms",
      likely_booking_window: "this_week",
      ai_summary: "New website lesson inquiry",
      ai_next_best_action: "Send fast follow-up and offer booking times",
      ai_last_reasoning: "Lead submitted form directly from website",
    };

    console.log("Insert payload:", insertPayload);

    const { data, error } = await supabaseAdmin
      .from("leads")
      .insert([insertPayload])
      .select()
      .single();

    console.log("Insert data:", data);
    console.log("Insert error:", error);

    if (error) {
      return NextResponse.json(
        { error: "Failed to save lead", details: error },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, lead: data });
  } catch (error) {
    console.error("Save route catch error:", error);
    return NextResponse.json(
      { error: "Server error", details: String(error) },
      { status: 500 }
    );
  }
}