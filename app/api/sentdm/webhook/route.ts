import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { logMessagingAudit } from "@/lib/messaging/audit";
import { reconcileMessageDeliveryPatch } from "@/lib/messaging/delivery-status-update";
import {
  extractSentDmMessageExternalId,
  isDeliveryFailureStatus,
  looksLikeInboundMessage,
  normalizeSentDmStatus,
  sentDmWebhookSignatureHeaderPresence,
  verifySentDmAuthenticity,
} from "@/lib/messaging/sentdm-webhook";
import { processSentDmWebhookJobFromPending } from "@/lib/sentdm/process-webhook-job";
import { computeWebhookJobDedupeKey } from "@/lib/sentdm/webhook-job-dedupe";
import { enqueueSentDmInboundWebhookJob } from "@/lib/sentdm/webhook-queue";

/**
 * CloseOS — Sent.dm Webhook Receiver
 * POST /api/sentdm/webhook
 *
 * Fast-acks Sent.dm: persists raw payload, enqueues inbound work to `webhook_jobs`,
 * returns 200 immediately; enrich / AI / outbound run in `after()` (+ cron fallback).
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function getSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "Missing Supabase env vars: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

function scheduleInboundJob(jobId: string) {
  after(async () => {
    try {
      const sb = getSupabase();
      await processSentDmWebhookJobFromPending(sb, jobId);
    } catch (err) {
      console.error("[sentdm/webhook] deferred webhook_jobs processing:", err);
    }
  });
}

export async function POST(req: NextRequest) {
  const receivedAt = new Date().toISOString();

  const rawBody = await req.text();
  const headerDiag = sentDmWebhookSignatureHeaderPresence(req);

  const verification = verifySentDmAuthenticity(req, rawBody);
  if (!verification.ok) {
    console.warn(
      `[sentdm/webhook] Rejected: ${verification.reason}; headers_present=`,
      headerDiag
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[sentdm/webhook] verified=", verification.mode, "headers=", headerDiag);

  let body: Record<string, unknown>;
  try {
    body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    console.error("[sentdm/webhook] Invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const eventType = String(
    body.sub_type ??
      body.subtype ??
      body.event ??
      body.type ??
      "unknown"
  );
  const externalId = extractSentDmMessageExternalId(body) ?? "";
  const status = normalizeSentDmStatus(
    (body.status ?? body.delivery_status) as string | undefined
  );
  const timestamp = (body.timestamp ?? receivedAt) as string;

  console.log(
    `[sentdm/webhook] event=${eventType} external_id=${externalId} status=${status} ts=${timestamp}`
  );

  if (!externalId) {
    console.warn(
      "[sentdm/webhook] Missing external_id — storing event but cannot reconcile delivery status"
    );
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    console.error("[sentdm/webhook] Supabase init failed:", err);
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 }
    );
  }

  const { error: insertError } = await supabase.from("webhook_events").insert({
    source: "sentdm",
    event_type: eventType,
    external_id: externalId || null,
    status,
    payload: body,
    received_at: receivedAt,
  });

  if (insertError) {
    console.error(
      "[sentdm/webhook] Failed to insert webhook_events:",
      insertError.message
    );
  }

  await logMessagingAudit(supabase, {
    event_type: "webhook_received",
    entity_type: "messaging",
    entity_id: externalId || null,
    metadata: {
      provider: "sentdm",
      route: "/api/sentdm/webhook",
      event_type: eventType,
      status,
      external_id: externalId || null,
      signature_mode: verification.mode,
      webhook_events_saved: !insertError,
    },
  });

  if (looksLikeInboundMessage(body)) {
    const enqueued = await enqueueSentDmInboundWebhookJob(supabase, {
      payload: body,
      eventType,
      ingestSource: "sentdm_webhook",
    });

    if (!enqueued.ok) {
      console.error("[sentdm/webhook] webhook_jobs enqueue failed:", enqueued.error);
      return NextResponse.json(
        { received: false, error: enqueued.error },
        { status: 503 }
      );
    }

    if (enqueued.duplicate) {
      await logMessagingAudit(supabase, {
        event_type: "webhook_duplicate_ignored",
        entity_type: "webhook_job",
        entity_id: null,
        metadata: {
          provider: "sentdm",
          dedupe_key: computeWebhookJobDedupeKey(body),
          event_type: eventType,
        },
      });
      return NextResponse.json(
        {
          received: true,
          queued: false,
          duplicate: true,
          event_stored: !insertError,
        },
        { status: 200 }
      );
    }

    await logMessagingAudit(supabase, {
      event_type: "webhook_job_created",
      entity_type: "webhook_job",
      entity_id: enqueued.jobId,
      metadata: {
        provider: "sentdm",
        event_type: eventType,
      },
    });

    scheduleInboundJob(enqueued.jobId);

    return NextResponse.json(
      {
        received: true,
        queued: true,
        job_id: enqueued.jobId,
        event_stored: !insertError,
      },
      { status: 200 }
    );
  }

  if (externalId) {
    const reconcileRes = await reconcileMessageDeliveryPatch(supabase, {
      externalIdTrimmed: externalId.trim(),
      deliveryStatus: status,
      touchedAtIso: receivedAt,
    });

    if (reconcileRes.errorMessage) {
      console.error(
        "[sentdm/webhook] Failed to reconcile delivery on messages:",
        reconcileRes.errorMessage
      );
      return NextResponse.json(
        {
          received: true,
          event_stored: !insertError,
          message_updated: false,
          lead_updated: false,
          error: reconcileRes.errorMessage,
        },
        { status: 200 }
      );
    }

    const messageUpdateData = reconcileRes.matchedMessage;

    if (messageUpdateData) {
      console.log(
        `[sentdm/webhook] Updated messages id=${messageUpdateData.id} -> ${status}`
      );

      if (isDeliveryFailureStatus(status)) {
        await logMessagingAudit(supabase, {
          event_type: "messaging_delivery_failed",
          entity_type: "message",
          entity_id: messageUpdateData.id as string,
          metadata: {
            provider: "sentdm",
            external_id: externalId,
            delivery_status: status,
            conversation_id: messageUpdateData.conversation_id,
          },
        });
      }

      return NextResponse.json(
        {
          received: true,
          event_stored: !insertError,
          message_updated: true,
          lead_updated: false,
          status,
        },
        { status: 200 }
      );
    }

    const { data: legacyUpdateData, error: legacyUpdateError } = await supabase
      .from("lead_messages")
      .update({
        delivery_status: status,
        delivery_updated_at: receivedAt,
      })
      .eq("external_id", externalId)
      .select("id")
      .maybeSingle();

    if (legacyUpdateError) {
      console.error(
        "[sentdm/webhook] Failed to update lead_messages:",
        legacyUpdateError.message
      );
      return NextResponse.json(
        {
          received: true,
          event_stored: !insertError,
          message_updated: false,
          lead_updated: false,
          error: legacyUpdateError.message,
        },
        { status: 200 }
      );
    }

    if (!legacyUpdateData) {
      const likelyEarlyStatus = ["queued", "routed", "sent"].includes(status.toLowerCase());
      const msg =
        `[sentdm/webhook] Delivery callback not correlated yet for external_id=${externalId}; ` +
        `status=${status}; row may be created shortly.`;
      if (likelyEarlyStatus) console.info(msg);
      else console.warn(msg);
    } else {
      console.log(
        `[sentdm/webhook] Updated legacy lead_messages id=${legacyUpdateData.id} -> ${status}`
      );
    }

    return NextResponse.json(
      {
        received: true,
        event_stored: !insertError,
        message_updated: false,
        lead_updated: !!legacyUpdateData,
        status,
      },
      { status: 200 }
    );
  }

  return NextResponse.json(
    {
      received: true,
      event_stored: !insertError,
      message_updated: false,
      lead_updated: false,
      status,
    },
    { status: 200 }
  );
}

export async function GET() {
  return NextResponse.json(
    { status: "ok", handler: "sentdm-webhook" },
    { status: 200 }
  );
}
