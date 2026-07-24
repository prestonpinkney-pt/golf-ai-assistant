import { NextResponse } from "next/server";
import { resolveOutboundSmsConsentGate } from "@/lib/messaging/outbound-sms-consent";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendMessage } from "@/lib/send-message";
import { gateCron } from "../../lib/require-auth";

const FOLLOW_UP_INTERVAL_HOURS = 24;
const MAX_FOLLOW_UPS = 2;

function getNextFollowUpDate(hoursFromNow: number) {
  const date = new Date();
  date.setHours(date.getHours() + hoursFromNow);
  return date.toISOString();
}

function buildFollowUpMessage(lead: { primaryIntent: string }) {
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

function isLikelyE164Phone(value: string) {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

export async function POST(req: Request) {
  const denied = gateCron(req);
  if (denied) return denied;

  try {
    const dueBefore = new Date();
    dueBefore.setHours(dueBefore.getHours() - FOLLOW_UP_INTERVAL_HOURS);
    const dueBeforeIso = dueBefore.toISOString();

    const { data: leads, error } = await supabaseAdmin
      .from("leads")
      .select(
        "id, full_name, phone, lead_type, status, follow_up_count, last_contacted_at, preferred_contact_channel"
      )
      .in("status", ["open", "contacted", "new"])
      .lt("follow_up_count", MAX_FOLLOW_UPS)
      .or(
        `last_contacted_at.is.null,last_contacted_at.lt.${dueBeforeIso}`
      )
      .order("created_at", { ascending: true })
      .limit(100);

    if (error) {
      return NextResponse.json(
        { error: error.message || "Failed to load due leads" },
        { status: 500 }
      );
    }

    let processedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const nowIso = new Date().toISOString();

    for (const lead of leads ?? []) {
      const previousCount = lead.follow_up_count ?? 0;
      if (previousCount >= MAX_FOLLOW_UPS) {
        skippedCount += 1;
        continue;
      }

      const lastContactedAt = lead.last_contacted_at
        ? new Date(lead.last_contacted_at).getTime()
        : null;
      if (
        lastContactedAt !== null &&
        Number.isFinite(lastContactedAt) &&
        lastContactedAt > dueBefore.getTime()
      ) {
        skippedCount += 1;
        continue;
      }

      const followUpMessage = buildFollowUpMessage({
        primaryIntent: lead.lead_type ?? "general",
      });
      const to = typeof lead.phone === "string" ? lead.phone.trim() : "";
      const channel = lead.preferred_contact_channel ?? "sms";

      if (channel !== "sms") {
        skippedCount += 1;
        continue;
      }

      if (!isLikelyE164Phone(to)) {
        failedCount += 1;
        console.error(
          `[run-due-follow-ups] Skipping lead ${lead.id}: missing valid E.164 phone`
        );
        continue;
      }

      const { data: contact, error: contactLookupError } = await supabaseAdmin
        .from("contacts")
        .select("sms_opt_out, cooling_off_until")
        .eq("phone", to)
        .maybeSingle();

      const consent = resolveOutboundSmsConsentGate({
        contact: contact
          ? {
              sms_opt_out: Boolean(contact.sms_opt_out),
              cooling_off_until:
                typeof contact.cooling_off_until === "string"
                  ? contact.cooling_off_until
                  : null,
            }
          : null,
        lookupError: contactLookupError,
      });
      if (!consent.allowed) {
        if (consent.status === 503) {
          failedCount += 1;
        } else {
          skippedCount += 1;
        }
        console.error(
          `[run-due-follow-ups] Skipping lead ${lead.id}: ${consent.error}`
        );
        continue;
      }

      const newCount = previousCount + 1;
      const nextFollowUpAt =
        newCount >= MAX_FOLLOW_UPS
          ? null
          : `Follow up after ${getNextFollowUpDate(FOLLOW_UP_INTERVAL_HOURS)}`;
      let smsResult: Awaited<ReturnType<typeof sendMessage>>;

      try {
        smsResult = await sendMessage({
          channel: "sms",
          to,
          message: followUpMessage,
          name: lead.full_name,
        });
      } catch (sendError) {
        failedCount += 1;
        const errorMessage =
          sendError instanceof Error ? sendError.message : String(sendError);
        console.error(
          `[run-due-follow-ups] Failed to send follow-up for lead ${lead.id}: ${errorMessage}`
        );
        await supabaseAdmin.from("lead_messages").insert([
          {
            lead_id: lead.id,
            direction: "outbound",
            channel: "sms",
            message_type: "follow_up",
            body: followUpMessage,
            delivery_status: "failed",
            ai_generated: true,
            sent_at: nowIso,
            provider: "sentdm",
          },
        ]);
        continue;
      }

      const { error: messageInsertError } = await supabaseAdmin
        .from("lead_messages")
        .insert([
          {
            lead_id: lead.id,
            direction: "outbound",
            channel: "sms",
            message_type: "follow_up",
            body: followUpMessage,
            delivery_status: smsResult.status || "sent",
            ai_generated: true,
            sent_at: nowIso,
            provider: smsResult.provider || "sentdm",
            external_id: smsResult.external_id,
          },
        ]);

      if (messageInsertError) {
        console.error(
          `[run-due-follow-ups] Failed to log follow-up for lead ${lead.id}: ${messageInsertError.message}`
        );
      }

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

      if (updateError) {
        failedCount += 1;
        console.error(
          `[run-due-follow-ups] Failed to update lead ${lead.id}: ${updateError.message}`
        );
        continue;
      }

      processedCount += 1;
    }

    return NextResponse.json({
      success: true,
      processedCount,
      skippedCount,
      failedCount,
      cutoff: dueBeforeIso,
    });
  } catch (error: unknown) {
    console.error("Run due follow-ups error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to run due follow-ups";

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
