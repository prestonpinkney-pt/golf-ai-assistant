import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isLikelyE164Phone } from "@/lib/campaigns/send-eligibility";
import { logMessagingAudit } from "@/lib/messaging/audit";
import { isInboundQuietHoursActive } from "@/lib/messaging/quiet-hours";
import { sendSentDmMessage } from "@/lib/sentdm/send-message";

const DEFER_BLOCKERS = new Set([
  "quiet_hours",
  "defer_outbound_sms",
]);

export type DeferredOutboundFlushResult = {
  scanned: number;
  sent: number;
  failed: number;
  skipped: number;
  quietHoursActive: boolean;
};

function readMeta(row: Record<string, unknown>): Record<string, unknown> {
  const meta = row.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    return meta as Record<string, unknown>;
  }
  return {};
}

function isDeferredOutboundCandidate(row: Record<string, unknown>): boolean {
  const status = String(row.status ?? "").toLowerCase();
  const delivery = String(row.delivery_status ?? "").toLowerCase();
  if (status !== "pending_send") return false;
  if (delivery !== "not_sent" && delivery !== "failed") return false;

  const meta = readMeta(row);
  const blocker = String(meta.provider_send_blocker ?? "");
  if (DEFER_BLOCKERS.has(blocker)) return true;
  if (meta.deferred_outbound === true) return true;
  if (meta.quiet_hours_active === true && blocker) return true;
  return false;
}

/**
 * Sends AI drafts that were persisted during quiet-hours defer once the
 * quiet window has ended. No-ops while quiet hours are still active.
 */
export async function flushDeferredQuietHoursOutbound(
  supabase: SupabaseClient,
  limit = 40
): Promise<DeferredOutboundFlushResult> {
  const quietHoursActive = isInboundQuietHoursActive();
  if (quietHoursActive) {
    return {
      scanned: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      quietHoursActive: true,
    };
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("messages")
    .select(
      "id, conversation_id, contact_id, contact_phone, message_text, body, channel, status, delivery_status, metadata"
    )
    .eq("direction", "outbound")
    .eq("status", "pending_send")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit * 3, 120)));

  if (error) {
    throw new Error(error.message);
  }

  const candidates = (data ?? []).filter((row) =>
    isDeferredOutboundCandidate(row as Record<string, unknown>)
  );
  const batch = candidates.slice(0, limit);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of batch) {
    const r = row as Record<string, unknown>;
    const text =
      (typeof r.message_text === "string" && r.message_text.trim()) ||
      (typeof r.body === "string" && r.body.trim()) ||
      "";
    const to =
      typeof r.contact_phone === "string" ? r.contact_phone.trim() : "";

    if (!text || !isLikelyE164Phone(to)) {
      skipped += 1;
      continue;
    }

    try {
      const sendRes = await sendSentDmMessage({
        to,
        message: text,
        channel: r.channel === "rcs" ? "rcs" : "sms",
        idempotencyKey: String(r.id),
      });
      const sentAt = new Date().toISOString();
      await supabase
        .from("messages")
        .update({
          status: sendRes.status ?? "queued",
          delivery_status: sendRes.status ?? "queued",
          provider: sendRes.provider,
          external_id: sendRes.external_id,
          provider_message_id: sendRes.external_id,
          sent_at: sentAt,
          metadata: {
            ...readMeta(r),
            deferred_outbound_flushed_at: sentAt,
            provider_send_blocker: null,
          },
        })
        .eq("id", r.id);

      if (typeof r.conversation_id === "string") {
        await supabase
          .from("conversations")
          .update({
            last_outbound_at: sentAt,
            last_ai_message_at: sentAt,
            last_message_at: sentAt,
          })
          .eq("id", r.conversation_id);
      }

      await logMessagingAudit(supabase, {
        event_type: "deferred_outbound_flushed",
        entity_type: "message",
        entity_id: String(r.id),
        metadata: {
          provider_message_id: sendRes.external_id,
          conversation_id: r.conversation_id ?? null,
        },
      });
      sent += 1;
    } catch (e: unknown) {
      failed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      await supabase
        .from("messages")
        .update({
          status: "failed",
          delivery_status: "failed",
          metadata: {
            ...readMeta(r),
            deferred_flush_error: msg,
          },
        })
        .eq("id", r.id);
      await logMessagingAudit(supabase, {
        event_type: "deferred_outbound_flush_failed",
        entity_type: "message",
        entity_id: String(r.id),
        metadata: { error: msg },
      });
    }
  }

  return {
    scanned: batch.length,
    sent,
    failed,
    skipped,
    quietHoursActive: false,
  };
}
