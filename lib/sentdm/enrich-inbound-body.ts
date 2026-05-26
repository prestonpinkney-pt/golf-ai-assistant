import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SentDmMessageDetails } from "@/lib/sentdm/get-message";
import { fetchSentDmMessageById } from "@/lib/sentdm/get-message";
import {
  evaluateCustomerInboundEligibility,
  textMatchesOurTemplateWrapperPrefix,
} from "@/lib/sentdm/sentdm-inbound-eligibility";
import {
  extractSentDmInboundPayload,
  extractSentDmMessageIdForLookup,
  normalizePhone,
} from "@/lib/messaging/sentdm-webhook";
import { firstString, readPath } from "@/lib/messaging/webhook-payload";

const isDevLogging =
  process.env.NODE_ENV === "development" ||
  ["1", "true", "yes", "on"].includes(
    (process.env.CLOSEOS_DEBUG_SENTDM_INBOUND ?? "").trim().toLowerCase()
  );

export type EnrichSentDmInboundBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string; messageId: string | null }
  | {
      ok: false;
      inboundSkipped: true;
      reason: string;
      messageId: string | null;
      details?: SentDmMessageDetails;
    };

function logDev(...args: unknown[]) {
  if (isDevLogging) {
    console.log("[sentdm-enrich]", ...args);
  }
}

function shallowPayload(body: Record<string, unknown>): Record<string, unknown> | null {
  const p = readPath(body, "payload");
  return p && typeof p === "object" && p !== null
    ? ({ ...(p as Record<string, unknown>) } as Record<string, unknown>)
    : null;
}

function normE164(phone: string | null | undefined): string | null {
  if (!phone?.trim()) return null;
  return normalizePhone(phone.trim());
}

/**
 * When Sent.dm omits text on `message.received`, or whenever `message_id` is present,
 * we call GET /v3/messages/{id}. **Inbound processing only proceeds when lookup reports
 * direction INBOUND + status RECEIVED** (see {@link evaluateCustomerInboundEligibility}).
 */
export async function enrichSentDmInboundBody(
  body: Record<string, unknown>
): Promise<EnrichSentDmInboundBodyResult> {
  const parsed = extractSentDmInboundPayload(body);
  const messageId = extractSentDmMessageIdForLookup(body);

  const payloadIn = shallowPayload(body) ?? {};
  const inboundHint = firstString(body, [
    "payload.inbound_number",
    "inbound_number",
    "payload.inboundNumber",
  ]);
  const outboundHint = firstString(body, [
    "payload.outbound_number",
    "outbound_number",
    "payload.outboundNumber",
  ]);
  const channelHint =
    firstString(body, ["payload.channel", "channel"])?.toLowerCase() === "rcs"
      ? "rcs"
      : "sms";

  if (messageId) {
    logDev("authoritative_lookup message_id=", messageId);
    const fetched = await fetchSentDmMessageById(messageId);
    if (!fetched.ok) {
      logDev("lookup_failed", fetched.error);
      return {
        ok: false,
        error: fetched.error,
        messageId,
      };
    }

    const d = fetched.details;
    const gate = evaluateCustomerInboundEligibility(
      {
        direction: d.direction,
        statusRaw: d.statusRaw,
        from: d.from,
        to: d.to,
      },
      body
    );

    if (!gate.allow) {
      logDev("inbound_blocked reason=", gate.reason, "lookup=", {
        direction: d.direction,
        statusRaw: d.statusRaw,
      });
      return {
        ok: false,
        inboundSkipped: true,
        reason: gate.reason,
        messageId,
        details: d,
      };
    }

    const text = d.text?.trim()?.length ? d.text.trim() : null;
    if (!text) {
      logDev("text_found=no after_successful_http");
      return {
        ok: false,
        error: "message_body_empty_after_lookup",
        messageId,
      };
    }

    logDev("inbound_eligible text_len=", text.length);

    const fromNorm = normE164(d.from) ?? normE164(inboundHint);
    const toNorm = normE164(d.to) ?? normE164(outboundHint);

    const nextPayload: Record<string, unknown> = {
      ...payloadIn,
      message_id: messageId,
      text,
      body: text,
      content: text,
      inbound_number: fromNorm ?? inboundHint,
      outbound_number: toNorm ?? outboundHint,
      channel: d.channel ?? channelHint,
    };

    const merged: Record<string, unknown> = {
      ...body,
      from: fromNorm,
      to: toNorm,
      text,
      body: text,
      message: text,
      message_id: messageId,
      external_id: messageId,
      channel: d.channel ?? channelHint,
      payload: nextPayload,
      _closeos_lookup: {
        direction: d.direction,
        status_raw: d.statusRaw,
      },
    };

    return { ok: true, body: merged };
  }

  if (parsed.messageText?.trim()?.length) {
    const t = parsed.messageText.trim();
    if (textMatchesOurTemplateWrapperPrefix(t)) {
      logDev("template_prefix_heuristic_skip_no_message_id");
      return {
        ok: false,
        inboundSkipped: true,
        reason: "suspected_outbound_template_no_message_id",
        messageId: null,
      };
    }
    logDev(
      "Inbound text envelope accepted without Sent.dm lookup; use message_id for full integration testing."
    );
    return { ok: true, body: { ...body } };
  }

  logDev("no message_id and no text");
  return {
    ok: false,
    error: "missing_message_text_and_message_id",
    messageId: null,
  };
}

export async function recordSentDmInboundEnrichFailure(
  supabase: SupabaseClient,
  input: {
    rawBody: Record<string, unknown>;
    error: string;
    messageId: string | null;
  }
) {
  const { error: insErr } = await supabase.from("inbound_events").insert({
    source: "sms",
    raw_payload: {
      envelope: input.rawBody,
      enrich_error: input.error,
      message_id: input.messageId,
    },
    status: "failed",
    error_message: input.error,
    error_source: "sentdm_message_lookup",
    retry_count: 0,
  });

  if (insErr) {
    console.warn(
      `[sentdm-enrich] inbound_events insert failed: ${insErr.message}`
    );
  }

  const { error: auditErr } = await supabase.from("audit_logs").insert({
    event_type: "sentdm_inbound_message_lookup_failed",
    entity_type: "messaging",
    entity_id: input.messageId,
    metadata: {
      error: input.error,
      message_id: input.messageId,
    },
  });

  if (auditErr) {
    console.warn(`[sentdm-enrich] audit_logs insert failed: ${auditErr.message}`);
  }
}
