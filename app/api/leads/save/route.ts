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

    // Get site
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

    // Save lead
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
          status: "new",
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

    // Format phone (IMPORTANT)
    let formattedPhone = phone;
    if (!phone.startsWith("+")) {
      formattedPhone = "+1" + phone.replace(/\D/g, "");
    }

    const smsBody = `Hey ${name}, thanks for reaching out to Primetime Golf. What day are you looking to come in?`;

    try {
      // Send SMS
      await sendSMS(formattedPhone, smsBody);

      // Log success
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

      return NextResponse.json({
        success: true,
        message: "Lead saved and SMS sent",
      });
    } catch (err) {
      // 👇 THIS IS THE IMPORTANT DEBUG PART
      const errorMessage =
        err instanceof Error ? err.message : JSON.stringify(err);

      console.error("SMS ERROR:", errorMessage);

      // Log failure WITH REAL ERROR
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