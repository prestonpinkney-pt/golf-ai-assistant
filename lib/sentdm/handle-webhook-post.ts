import { NextResponse, after } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logMessagingAudit } from "@/lib/messaging/audit";
import { reconcileMessageDeliveryPatch } from "@/lib/messaging/delivery-status-update";
import {
  extractSentDmMessageExternalId,
  isDeliveryFailureStatus,
  looksLikeInboundMessage,
  normalizeSentDmStatus,
  type SentDmWebhookVerification,
} from "@/lib/messaging/sentdm-webhook";
import { processSentDmWebhookJobFromPending } from "@/lib/sentdm/process-webhook-job";
import { computeWebhookJobDedupeKey } from "@/lib/sentdm/webhook-job-dedupe";
import { enqueueSentDmInboundWebhookJob, type SentDmWebhookJobIngestSource } from "@/lib/sentdm/webhook-queue";

export type SentDmWebhookRouteOptions = {
  route: string;
  webhookEventSource: string;
  ingestSource: SentDmWebhookJobIngestSource;
  legacyRoute?: boolean;
};

function getSupabase(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
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

/**
 * Canonical Sent.dm webhook processing: persist event, enqueue inbound jobs,
 * reconcile delivery callbacks. Used by /api/sentdm/webhook and legacy /api/webhooks/sent.
 */
export async function handleSentDmWebhookPost(
  body: Record<string, unknown>,
  verification: SentDmWebhookVerification,
  options: SentDmWebhookRouteOptions
): Promise<NextResponse> {
  const receivedAt = new Date().toISOString();
  const eventType = String(
    body.sub_type ?? body.subtype ?? body.event ?? body.type ?? "unknown"
  );
  const externalId = extractSentDmMessageExternalId(body) ?? "";
  const status = normalizeSentDmStatus(
    (body.status ?? body.delivery_status) as string | undefined
  );
  const timestamp = (body.timestamp ?? receivedAt) as string;

  console.log(
    `[${options.route}] event=${eventType} external_id=${externalId} status=${status} ts=${timestamp}`
  );

  if (!externalId) {
    console.warn(
      `[${options.route}] Missing external_id — storing event but cannot reconcile delivery status`
    );
  }

  let supabase: SupabaseClient;
  try {
    supabase = getSupabase();
  } catch (err) {
    console.error(`[${options.route}] Supabase init failed:`, err);
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 }
    );
  }

  const { error: insertError } = await supabase.from("webhook_events").insert({
    source: options.webhookEventSource,
    event_type: eventType,
    external_id: externalId || null,
    status,
    payload: body,
    received_at: receivedAt,
  });

  if (insertError) {
    console.error(
      `[${options.route}] Failed to insert webhook_events:`,
      insertError.message
    );
  }

  await logMessagingAudit(supabase, {
    event_type: options.legacyRoute
      ? "provider_webhook_received"
      : "webhook_received",
    entity_type: "messaging",
    entity_id: externalId || null,
    metadata: {
      provider: "sentdm",
      route: options.route,
      event_type: eventType,
      status,
      external_id: externalId || null,
      signature_mode: verification.ok ? verification.mode : undefined,
      webhook_events_saved: !insertError,
      ...(options.legacyRoute
        ? {
            deprecation:
              "Prefer POST /api/sentdm/webhook — legacy route uses the same queue pipeline.",
          }
        : {}),
    },
  });

  const legacyFields = options.legacyRoute
    ? { legacy_route: true, canonical_route: "/api/sentdm/webhook" as const }
    : {};

  if (looksLikeInboundMessage(body)) {
    const enqueued = await enqueueSentDmInboundWebhookJob(supabase, {
      payload: body,
      eventType,
      ingestSource: options.ingestSource,
    });

    if (!enqueued.ok) {
      console.error(`[${options.route}] webhook_jobs enqueue failed:`, enqueued.error);
      return NextResponse.json(
        {
          ...legacyFields,
          received: false,
          error: enqueued.error,
        },
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
          ...legacyFields,
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
        ...legacyFields,
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
        `[${options.route}] Failed to reconcile delivery on messages:`,
        reconcileRes.errorMessage
      );
      return NextResponse.json(
        {
          ...legacyFields,
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
        `[${options.route}] Updated messages id=${messageUpdateData.id} -> ${status}`
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
          ...legacyFields,
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
        `[${options.route}] Failed to update lead_messages:`,
        legacyUpdateError.message
      );
      return NextResponse.json(
        {
          ...legacyFields,
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
      const likelyEarlyStatus = ["queued", "routed", "sent"].includes(
        status.toLowerCase()
      );
      const msg =
        `[${options.route}] Delivery callback not correlated yet for external_id=${externalId}; ` +
        `status=${status}; row may be created shortly.`;
      if (likelyEarlyStatus) console.info(msg);
      else console.warn(msg);
    } else {
      console.log(
        `[${options.route}] Updated legacy lead_messages id=${legacyUpdateData.id} -> ${status}`
      );
    }

    return NextResponse.json(
      {
        ...legacyFields,
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
      ...legacyFields,
      received: true,
      event_stored: !insertError,
      message_updated: false,
      lead_updated: false,
      status,
      ...(options.legacyRoute ? { ignored: true, reason: "not_inbound_event" } : {}),
    },
    { status: 200 }
  );
}
