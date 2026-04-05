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

    const { data: lead, error: leadError } = await supabaseAdmin
      .from("leads")
      .insert([insertPayload])
      .select()
      .single();

    console.log("Lead insert result:", lead);
    console.log("Lead insert error:", leadError);

    if (leadError || !lead) {
      return NextResponse.json(
        { error: "Failed to save lead", details: leadError },
        { status: 500 }
      );
    }

    const smsBody = `Hey ${name}, thanks for reaching out to Primetime Golf. Got your inquiry and I’d be happy to help get you booked. What day are you looking to come in?`;

    console.log("About to send SMS...");
    console.log("Phone:", phone);
    console.log("SMS body:", smsBody);

    let smsResult: unknown = null;
    let smsError: unknown = null;
    let messageLogResult: unknown = null;
    let messageLogError: unknown = null;

    try {
      smsResult = await sendSMS(phone, smsBody);
      console.log("SMS send result:", smsResult);

      const logInsert = await supabaseAdmin.from("lead_messages").insert([
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

      messageLogResult = logInsert.data;
      messageLogError = logInsert.error;

      console.log("Lead message log result:", messageLogResult);
      console.log("Lead message log error:", messageLogError);

      await supabaseAdmin
        .from("leads")
        .update({
          status: "contacted",
          last_contacted_at: new Date().toISOString(),
          follow_up_count: 1,
        })
        .eq("id", lead.id);
    } catch (err) {
      smsError = err;
      console.error("SMS block error:", err);

      const failedLogInsert = await supabaseAdmin.from("lead_messages").insert([
        {
          lead_id: lead.id,
          direction: "outbound",
          channel: "sms",
          message_type: "initial_response",
          body: smsBody,
          delivery_status: "failed",
          ai_generated: true,
          sent_at: new Date().toISOString(),
        },
      ]);

      console.log("Failed log insert data:", failedLogInsert.data);
      console.log("Failed log insert error:", failedLogInsert.error);
    }

    return NextResponse.json({
      success: true,
      lead,
      smsResult,
      smsError: smsError ? String(smsError) : null,
      messageLogResult,
      messageLogError,
    });
  } catch (error) {
    console.error("Save route catch error:", error);
    return NextResponse.json(
      { error: "Server error", details: String(error) },
      { status: 500 }
    );
  }
}