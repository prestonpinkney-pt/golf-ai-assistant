import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createSmsBookingNoneAugmentation,
  runCloseOsSmsBookingAugmentation,
  type BookingFlowAugmentation,
} from "@/lib/ai/sms-booking-flow";
import { decidePlaybook, type ConversationHistoryMessage } from "@/lib/ai/conversation-reply-core";
import { logMessagingAudit } from "@/lib/messaging/audit";

function safeError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export async function loadSmsConversationHistoryAscending(
  supabase: SupabaseClient,
  conversationId: string,
  limit = 20
): Promise<ConversationHistoryMessage[]> {
  const { data } = await supabase
    .from("messages")
    .select("direction, channel, message_text, status, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return [...((data ?? []) as ConversationHistoryMessage[])].reverse();
}

/**
 * Live Sent.dm inbound SMS parity with `/api/ai/respond`: Whoosh booking augmentation + sms_booking_flow_started audit.
 * Booking POSTs reuse `runCloseOsSmsBookingAugmentation` → `whooshBookingClient.createBooking`,
 * implemented by `createWhooshBooking` in `@/lib/whoosh/bookings` (same wire as `/api/ai/respond`).
 * RCS callers should bypass (not invoke this).
 */
export async function runInboundSmsBookingAugmentationPhase(input: {
  supabase: SupabaseClient;
  conversationId: string;
  businessId: string | null | undefined;
  contactId: string | null | undefined;
  contactName: string | null | undefined;
  contactPhone: string | null | undefined;
  /** Whoosh / club member id when supplied by ingest (e.g. from contact enrichment). */
  contactMemberNumber?: string | null | undefined;
  inboundText: string;
  /** e.g. `sentdm_webhook`, `sentdm_inbound_route` */
  ingestSource: string;
}): Promise<{
  playbook: string;
  conversationHistory: ConversationHistoryMessage[];
  smsBookingFlow: BookingFlowAugmentation;
}> {
  const playbook = decidePlaybook(input.inboundText);
  const conversationHistory = await loadSmsConversationHistoryAscending(
    input.supabase,
    input.conversationId
  );

  if (!input.businessId) {
    return {
      playbook,
      conversationHistory,
      smsBookingFlow: createSmsBookingNoneAugmentation(
        "sentdm_inbound_missing_business_config_id"
      ),
    };
  }

  await logMessagingAudit(input.supabase, {
    event_type: "sms_booking_flow_started",
    entity_type: "conversation",
    entity_id: input.conversationId,
    metadata: {
      source: input.ingestSource,
      playbook,
      business_id: input.businessId,
    },
  });

  let smsBookingFlow: BookingFlowAugmentation =
    createSmsBookingNoneAugmentation("pending_sentdm_sms_augment_initial");

  try {
    smsBookingFlow = await runCloseOsSmsBookingAugmentation({
      supabase: input.supabase,
      businessId: input.businessId,
      conversationId: input.conversationId,
      contactId: input.contactId ?? null,
      contactName:
        typeof input.contactName === "string" ? input.contactName : null,
      contactPhone:
        typeof input.contactPhone === "string" ? input.contactPhone : null,
      contactMemberNumber:
        typeof input.contactMemberNumber === "string" && input.contactMemberNumber.trim() ?
          input.contactMemberNumber.trim()
        : null,
      inboundText: input.inboundText,
      playbook,
      conversationHistory,
    });
  } catch (error: unknown) {
    console.warn(
      "[sentdm/inbound-sms-booking-phase] augmentation error:",
      safeError(error, "unknown_error")
    );
    smsBookingFlow = createSmsBookingNoneAugmentation(
      "sms_booking_augment_threw_error_sentdm_path"
    );
  }

  return { playbook, conversationHistory, smsBookingFlow };
}
