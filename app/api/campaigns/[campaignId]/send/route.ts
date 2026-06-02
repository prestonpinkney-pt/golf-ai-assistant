import { ApiAuthError, requireBusinessUser } from "@/app/api/lib/require-auth";
import { refreshCampaignRollup } from "@/lib/campaigns/rollup";
import {
  evaluateCampaignRecipientPolicy,
  evaluateCampaignSendWindow,
  evaluateCampaignTestAllowlist,
  isLikelyE164Phone,
} from "@/lib/campaigns/send-eligibility";
import { logMessagingAudit } from "@/lib/messaging/audit";
import { normalizePhone } from "@/lib/messaging/phone";
import { sendMessage } from "@/lib/send-message";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { UUID_RE, errorMessage, jsonNoStore } from "../../_http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_MESSAGE_LENGTH = 1600;

export async function POST(
  req: Request,
  context: { params: Promise<{ campaignId: string }> }
) {
  let userId: string;
  let businessId: string;
  try {
    const ctx = await requireBusinessUser();
    userId = ctx.user.id;
    businessId = ctx.businessId;
  } catch (e) {
    if (e instanceof ApiAuthError) {
      return jsonNoStore({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  const { campaignId } = await context.params;
  if (!campaignId || !UUID_RE.test(campaignId)) {
    return jsonNoStore({ error: "Invalid campaign id" }, { status: 400 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const payload = (body ?? {}) as { messageIds?: unknown };
  const filterIds =
    Array.isArray(payload.messageIds) && payload.messageIds.length > 0
      ? new Set(
          payload.messageIds.filter(
            (id): id is string => typeof id === "string" && UUID_RE.test(id)
          )
        )
      : null;

  const supabase = createSupabaseServiceRoleClient();

  const { data: campaign, error: cErr } = await supabase
    .from("campaigns")
    .select("id, name")
    .eq("id", campaignId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (cErr || !campaign) {
    return jsonNoStore({ error: "Campaign not found" }, { status: 404 });
  }

  const { data: approvedRows, error: listErr } = await supabase
    .from("campaign_messages")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("status", "approved");

  if (listErr) {
    console.error("campaign send list:", listErr.message);
    return jsonNoStore({ error: "Failed to load messages" }, { status: 500 });
  }

  const toSend = (approvedRows ?? []).filter(
    (r) => !filterIds || filterIds.has(r.id as string)
  );

  if (toSend.length === 0) {
    return jsonNoStore(
      { error: "No approved messages ready to send" },
      { status: 400 }
    );
  }

  const sendWindow = evaluateCampaignSendWindow();
  if (!sendWindow.allowed) {
    return jsonNoStore(
      { error: sendWindow.detail, reason: sendWindow.reason },
      { status: 423 }
    );
  }

  await logMessagingAudit(supabase, {
    event_type: "campaign_send_batch_started",
    entity_type: "campaign",
    entity_id: campaignId,
    metadata: {
      business_id: businessId,
      user_id: userId,
      count: toSend.length,
    },
  });

  const results: {
    id: string;
    outcome: "sent" | "failed";
    error?: string;
  }[] = [];

  for (const cm of toSend) {
    const messageId = cm.id as string;

    const { data: claimed, error: claimErr } = await supabase
      .from("campaign_messages")
      .update({
        status: "sending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", messageId)
      .eq("campaign_id", campaignId)
      .eq("status", "approved")
      .select()
      .maybeSingle();

    if (claimErr || !claimed) {
      continue;
    }

    const messageText = (cm.message_text as string)?.trim() ?? "";
    if (!messageText || messageText.length > MAX_MESSAGE_LENGTH) {
      const err = !messageText ? "Empty message" : "Message too long";
      await supabase
        .from("campaign_messages")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          error_message: err,
          updated_at: new Date().toISOString(),
        })
        .eq("id", messageId);
      results.push({ id: messageId, outcome: "failed", error: err });
      continue;
    }

    const rawPhone = typeof cm.phone === "string" ? cm.phone.trim() : "";
    const toPhone = normalizePhone(rawPhone || null);
    if (!toPhone || !isLikelyE164Phone(toPhone)) {
      const err = "Invalid or missing E.164 phone";
      await supabase
        .from("campaign_messages")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          error_message: err,
          updated_at: new Date().toISOString(),
        })
        .eq("id", messageId);
      await logMessagingAudit(supabase, {
        event_type: "campaign_send_blocked_invalid_phone",
        entity_type: "campaign_message",
        entity_id: messageId,
        metadata: {
          business_id: businessId,
          user_id: userId,
          campaign_id: campaignId,
          phone: rawPhone || null,
        },
      });
      results.push({ id: messageId, outcome: "failed", error: err });
      continue;
    }

    const allowTest = evaluateCampaignTestAllowlist(toPhone);
    if (!allowTest.allowed) {
      const now = new Date().toISOString();
      await supabase
        .from("campaign_messages")
        .update({
          status: "failed",
          failed_at: now,
          error_message: allowTest.detail,
          updated_at: now,
        })
        .eq("id", messageId);
      await logMessagingAudit(supabase, {
        event_type: "campaign_send_blocked_test_allowlist",
        entity_type: "campaign_message",
        entity_id: messageId,
        metadata: {
          business_id: businessId,
          user_id: userId,
          campaign_id: campaignId,
          phone: toPhone,
        },
      });
      results.push({ id: messageId, outcome: "failed", error: allowTest.detail });
      continue;
    }

    const { data: contact } = await supabase
      .from("contacts")
      .select("id, name, phone, sms_opt_out, cooling_off_until")
      .eq("phone", toPhone)
      .maybeSingle();

    if (contact?.sms_opt_out) {
      const now = new Date().toISOString();
      await supabase
        .from("campaign_messages")
        .update({
          status: "failed",
          failed_at: now,
          error_message: "Contact opted out of SMS",
          contact_id: contact.id as string,
          updated_at: now,
        })
        .eq("id", messageId);
      await logMessagingAudit(supabase, {
        event_type: "campaign_send_blocked_opt_out",
        entity_type: "campaign_message",
        entity_id: messageId,
        metadata: {
          business_id: businessId,
          user_id: userId,
          campaign_id: campaignId,
          contact_id: contact.id,
        },
      });
      results.push({
        id: messageId,
        outcome: "failed",
        error: "Contact has opted out of SMS",
      });
      continue;
    }

    if (
      contact &&
      contact.cooling_off_until &&
      new Date(contact.cooling_off_until as string) > new Date()
    ) {
      const now = new Date().toISOString();
      await supabase
        .from("campaign_messages")
        .update({
          status: "failed",
          failed_at: now,
          error_message: "Contact is in a cooling-off period",
          contact_id: contact.id as string,
          updated_at: now,
        })
        .eq("id", messageId);
      await logMessagingAudit(supabase, {
        event_type: "campaign_send_blocked_cooling_off",
        entity_type: "campaign_message",
        entity_id: messageId,
        metadata: {
          business_id: businessId,
          user_id: userId,
          campaign_id: campaignId,
          contact_id: contact.id,
        },
      });
      results.push({
        id: messageId,
        outcome: "failed",
        error: "Cooling-off period active",
      });
      continue;
    }

    const policy = await evaluateCampaignRecipientPolicy(supabase, {
      contactId: (contact?.id as string | undefined) ?? null,
      phone: toPhone,
      smsOptOut: false,
    });
    if (!policy.allowed) {
      const now = new Date().toISOString();
      await supabase
        .from("campaign_messages")
        .update({
          status: "failed",
          failed_at: now,
          error_message: policy.detail,
          contact_id: contact?.id ?? null,
          updated_at: now,
        })
        .eq("id", messageId);
      await logMessagingAudit(supabase, {
        event_type: "campaign_send_blocked_policy",
        entity_type: "campaign_message",
        entity_id: messageId,
        metadata: {
          business_id: businessId,
          user_id: userId,
          campaign_id: campaignId,
          reason: policy.reason,
          policy_reason_codes: policy.policyReasonCodes,
        },
      });
      results.push({ id: messageId, outcome: "failed", error: policy.detail });
      continue;
    }

    const contactId = (contact?.id as string | undefined) ?? null;
    let conversationId: string | null = null;
    let leadId: string | null = null;

    if (contactId) {
      const { data: conv } = await supabase
        .from("conversations")
        .select("id, lead_id")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (conv) {
        conversationId = conv.id as string;
        leadId = (conv.lead_id as string | null) ?? null;
      }
    }

    let outboundMessageId: string | null = null;

    const insertPayload = {
      conversation_id: conversationId,
      contact_id: contactId,
      lead_id: leadId,
      direction: "outbound" as const,
      channel: "sms",
      contact_phone: toPhone,
      message_text: messageText,
      status: "pending_send" as const,
      delivery_status: "not_sent" as const,
      ai_generated: false,
      metadata: {
        campaign_id: campaignId,
        campaign_message_id: messageId,
        business_id: businessId,
        operator_user_id: userId,
        campaign_send: true,
      },
    };

    const { data: outboundMessage, error: insertError } = await supabase
      .from("messages")
      .insert(insertPayload)
      .select()
      .single();

    if (insertError || !outboundMessage) {
      const now = new Date().toISOString();
      const err = insertError?.message || "Failed to create outbound message row";
      console.error(
        "campaign send messages insert failed:",
        err
      );
      await supabase
        .from("campaign_messages")
        .update({
          status: "failed",
          failed_at: now,
          error_message: "Outbound ledger insert failed before provider send",
          contact_id: contactId,
          conversation_id: conversationId,
          updated_at: now,
        })
        .eq("id", messageId);
      await logMessagingAudit(supabase, {
        event_type: "campaign_send_blocked_ledger_insert_failed",
        entity_type: "campaign_message",
        entity_id: messageId,
        metadata: {
          business_id: businessId,
          user_id: userId,
          campaign_id: campaignId,
          contact_id: contactId,
          conversation_id: conversationId,
          error: err,
        },
      });
      results.push({
        id: messageId,
        outcome: "failed",
        error: "Outbound ledger insert failed before provider send",
      });
      continue;
    }
    outboundMessageId = outboundMessage.id as string;

    const displayName =
      (typeof cm.contact_name === "string" && cm.contact_name.trim()) ||
      (typeof contact?.name === "string" ? contact.name : null);

    try {
      const result = await sendMessage({
        channel: "sms",
        to: toPhone,
        message: messageText,
        name: displayName,
      });

      const sendStatus = result.status || "queued";
      const sentAt = new Date().toISOString();

      if (outboundMessageId) {
        await supabase
          .from("messages")
          .update({
            status: sendStatus,
            provider: result.provider,
            external_id: result.external_id,
            provider_message_id: result.external_id,
            delivery_status: sendStatus,
            sent_at: sentAt,
          })
          .eq("id", outboundMessageId);

        if (conversationId) {
          await supabase
            .from("conversations")
            .update({
              last_message_at: sentAt,
              last_outbound_at: sentAt,
            })
            .eq("id", conversationId);
        }
      }

      await supabase
        .from("campaign_messages")
        .update({
          status: "sent",
          sent_at: sentAt,
          delivery_status: sendStatus,
          external_id: result.external_id,
          contact_id: contactId,
          conversation_id: conversationId,
          error_message: null,
          failed_at: null,
          updated_at: sentAt,
        })
        .eq("id", messageId);

      await logMessagingAudit(supabase, {
        event_type: "campaign_message_sent",
        entity_type: "campaign_message",
        entity_id: messageId,
        metadata: {
          business_id: businessId,
          user_id: userId,
          campaign_id: campaignId,
          messages_row_id: outboundMessageId,
          provider: result.provider,
          external_id: result.external_id,
          status: sendStatus,
        },
      });

      results.push({ id: messageId, outcome: "sent" });
    } catch (sendErr: unknown) {
      const sendErrorMessage = errorMessage(sendErr, "Provider send failed");
      const failedAt = new Date().toISOString();

      if (outboundMessageId) {
        await supabase
          .from("messages")
          .update({
            status: "failed",
            delivery_status: "failed",
            metadata: {
              send_error: sendErrorMessage,
              campaign_id: campaignId,
              campaign_message_id: messageId,
            },
          })
          .eq("id", outboundMessageId);
      }

      await supabase
        .from("campaign_messages")
        .update({
          status: "failed",
          failed_at: failedAt,
          error_message: sendErrorMessage,
          contact_id: contactId,
          conversation_id: conversationId,
          updated_at: failedAt,
        })
        .eq("id", messageId);

      await logMessagingAudit(supabase, {
        event_type: "campaign_message_send_failed",
        entity_type: "campaign_message",
        entity_id: messageId,
        metadata: {
          business_id: businessId,
          user_id: userId,
          campaign_id: campaignId,
          messages_row_id: outboundMessageId,
          error: sendErrorMessage,
        },
      });

      results.push({
        id: messageId,
        outcome: "failed",
        error: sendErrorMessage,
      });
    }

  }

  await logMessagingAudit(supabase, {
    event_type: "campaign_send_batch_finished",
    entity_type: "campaign",
    entity_id: campaignId,
    metadata: {
      business_id: businessId,
      user_id: userId,
      results,
    },
  });

  try {
    await refreshCampaignRollup(supabase, campaignId);
  } catch (rollupErr) {
    console.error("refreshCampaignRollup final:", rollupErr);
  }

  return jsonNoStore({
    ok: true,
    results,
    sent: results.filter((r) => r.outcome === "sent").length,
    failed: results.filter((r) => r.outcome === "failed").length,
  });
}
