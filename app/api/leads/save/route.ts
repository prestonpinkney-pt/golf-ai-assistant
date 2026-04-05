import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabase/server";
import { sendSMS } from "../../../../lib/twilio";

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

    const { data, error } = await supabaseAdmin
      .from("leads")
      .insert([insertPayload])
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { error: "Failed to save lead", details: error },
        { status: 500 }
      );
    }

    let smsResult: unknown = null;
    let smsError: unknown = null;

    try {
      const smsBody = `Hey ${name}, thanks for reaching out to Primetime Golf. Got your inquiry and I’d be happy to help get you booked. What day are you looking to come in?`;

      smsResult = await sendSMS(phone, smsBody);

      await supabaseAdmin.from("lead_messages").insert([
        {
          lead_id: data.id,
          direction: "outbound",
          channel: "sms",
          message_type: "initial_response",
          body: smsBody,
          delivery_status: "sent",
          ai_generated: true,
          template_type: "initial_response",
          sent_at: new Date().toISOString(),
        },
      ]);

      await supabaseAdmin
        .from("leads")
        .update({
          status: "contacted",
          last_contacted_at: new Date().toISOString(),
          follow_up_count: 1,
        })
        .eq("id", data.id);
    } catch (err) {
      smsError = err;

      await supabaseAdmin.from("lead_messages").insert([
        {
          lead_id: data.id,
          direction: "outbound",
          channel: "sms",
          message_type: "initial_response",
          body: "SMS send attempted but failed.",
          delivery_status: "failed",
          ai_generated: true,
          template_type: "initial_response",
          sent_at: new Date().toISOString(),
        },
      ]);
    }

    return NextResponse.json({
      success: true,
      lead: data,
      smsResult,
      smsError: smsError ? String(smsError) : null,
    });
  } catch (error) {
    console.error("Save route catch error:", error);
    return NextResponse.json(
      { error: "Server error", details: String(error) },
      { status: 500 }
    );
  }
}