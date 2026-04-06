import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabase/server";
import { sendSMS } from "../../../../lib/twilio";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const { name, phone, email, message } = body;

    if (!name || !phone || !email || !message) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const { data: site, error: siteError } = await supabaseAdmin
      .from("sites")
      .select("id, domain")
      .eq("domain", "primetimegolf.org")
      .single();

    if (siteError || !site) {
      return NextResponse.json(
        { error: "Site not found", details: siteError },
        { status: 500 }
      );
    }

    const { data: lead, error: leadError } = await supabaseAdmin
      .from("leads")
      .insert([
        {
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
          follow_up_count: 0,
          ai_summary: "New website lesson inquiry",
          ai_next_best_action:
            "Send immediate follow-up and ask what day they want to come in",
          ai_last_reasoning:
            "Lead submitted a website form asking about booking a lesson",
        },
      ])
      .select()
      .single();

    if (leadError || !lead) {
      return NextResponse.json(
        { error: "Failed to save lead", details: leadError },
        { status: 500 }
      );
    }

    let formattedPhone = phone;
    if (!formattedPhone.startsWith("+")) {
      formattedPhone = "+1" + formattedPhone.replace(/\D/g, "");
    }

    const smsBody = `Hey ${name}, thanks for reaching out to Primetime Golf. Got your inquiry and I’d be happy to help get you booked. What day are you looking to come in?`;

    try {
      const smsResult = await sendSMS(formattedPhone, smsBody);

      await supabaseAdmin.from("lead_messages").insert([
        {
          lead_id: lead.id,
          direction: "outbound",
          channel: "sms",
          message_type: "initial_response",
          body: smsBody,
          delivery_status: "sent",
          ai_generated: true,
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
        .eq("id", lead.id);

      return NextResponse.json({
        success: true,
        message: "Lead saved and SMS sent",
        lead,
        smsResult,
      });
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : JSON.stringify(err);

      await supabaseAdmin.from("lead_messages").insert([
        {
          lead_id: lead.id,
          direction: "outbound",
          channel: "sms",
          message_type: "initial_response",
          body: `SMS failed: ${errorMessage}`,
          delivery_status: "failed",
          ai_generated: true,
          sent_at: new Date().toISOString(),
        },
      ]);

      return NextResponse.json({
        success: true,
        message: "Lead saved but SMS failed",
        lead,
        smsError: errorMessage,
      });
    }
  } catch (error) {
    return NextResponse.json(
      { error: "Server error", details: String(error) },
      { status: 500 }
    );
  }
}