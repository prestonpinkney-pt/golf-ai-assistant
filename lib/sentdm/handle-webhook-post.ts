import { NextResponse, after } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logMessagingAudit } from "@/lib/messaging/audit";
import { reconcileMessageDeliveryPatch } from "@/lib/messaging/delivery-status-update";
import {
  buildSentDmWebhookLogSummary,
  extractSentDmContactId,
  extractSentDmMessageExternalId,
  extractSentDmMessageIdForLookup,
  hasSentDmInboundText,
  isDeliveryFailureStatus,
  logSentDmWebhookSummary,
  looksLikeInboundMessage,
  normalizeSentDmStatus,
  shouldWarnMissingExternalId,
  type SentDmWebhookLogSummary,
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

type WebhookLogContext = {
  eventType: string;
  verificationMode: string;
  body: Record<string, unknown>;
  externalId: string;
  status: string;
  looksInbound: boolean;
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

function verificationModeLabel(verification: SentDmWebhookVerification): string {
  return verification.ok ? verification.mode : "rejected";
}

function emitFinalWebhookLog(
  route: string,
  ctx: WebhookLogContext,
  extra: Omit<
    Parameters<typeof buildSentDmWebhookLogSummary>[0],
    keyof WebhookLogContext
  >
) {
  const summary = buildSentDmWebhookLogSummary({ ...ctx, ...extra });
  logSentDmWebhookSummary(route, summary);
  return summary;
}

function maybeLogInboundTextHint(route: string, summary: SentDmWebhookLogSummary) {
  if (summary.mode === "local_text_envelope") {
    console.info(
      `[${route}] Inbound text envelope accepted without Sent.dm lookup; use message_id for full integration testing.`
    );
  }
  if (summary.mode === "integration_message_lookup") {
    console.info(
      `[${route}] Inbound queued with message_id — Sent.dm GET /v3/messages/{id} enrichment will run.`
    );
  }
}

function buildInboundIntegrationResponse(input: {
  eventType: string;
  message_id: string | null;
  contactId: string | null;
  status: "processed" | "queued" | "failed" | "skipped";
  conversation_id?: string | null;
  inbound_message_id?: string | null;
  inbound_event_id?: string | null;
  verificationMode: string;
  job_id?: string;
  error?: string | null;
  skipReason?: string | null;
  legacyFields?: Record<string, unknown>;
}) {
  return {
    ...(input.legacyFields ?? {}),
    eventType: input.eventType,
    message_id: input.message_id,
    contactId: input.contactId,
    status: input.status,
    verificationMode: input.verificationMode,
    ...(input.conversation_id ? { conversation_id: input.conversation_id } : {}),
    ...(input.inbound_message_id ?
      { inbound_message_id: input.inbound_message_id }
    : {}),
    ...(input.inbound_event_id ? { inbound_event_id: input.inbound_event_id } : {}),
    ...(input.job_id ? { job_id: input.job_id } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.skipReason ? { skip_reason: input.skipReason } : {}),
    received: true,
  };
}

function maybeWarnMissingExternalId(
  route: string,
  ctx: WebhookLogContext
) {
  if (
    shouldWarnMissingExternalId({
      externalId: ctx.externalId,
      looksInbound: ctx.looksInbound,
      body: ctx.body,
    })
  ) {
    console.warn(
      `[${route}] Delivery/status callback missing message id — cannot reconcile delivery status`
    );
  }
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
  const messageIdForLookup = extractSentDmMessageIdForLookup(body);
  const externalId = messageIdForLookup ?? extractSentDmMessageExternalId(body) ?? "";
  const webhookContactId = extractSentDmContactId(body);
  const status = normalizeSentDmStatus(
    (body.status ?? body.delivery_status) as string | undefined
  );
  const looksInbound = looksLikeInboundMessage(body);
  const verificationMode = verificationModeLabel(verification);
  const logCtx: WebhookLogContext = {
    eventType,
    verificationMode,
    body,
    externalId,
    status,
    looksInbound,
  };

  void (body.timestamp ?? receivedAt);

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

  if (looksInbound) {
    const enqueued = await enqueueSentDmInboundWebhookJob(supabase, {
      payload: body,
      eventType,
      ingestSource: options.ingestSource,
    });

    if (!enqueued.ok) {
      console.error(`[${options.route}] webhook_jobs enqueue failed:`, enqueued.error);
      emitFinalWebhookLog(options.route, logCtx, {
        queued: false,
        reason: "enqueue_failed",
      });
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
      emitFinalWebhookLog(options.route, logCtx, {
        queued: false,
        duplicate: true,
        reason: "duplicate_job",
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

    const summary = emitFinalWebhookLog(options.route, logCtx, { queued: true });
    maybeLogInboundTextHint(options.route, summary);

    const runSynchronously = (messageIdForLookup?.trim().length ?? 0) > 0;

    if (runSynchronously) {
      const processResult = await processSentDmWebhookJobFromPending(
        supabase,
        enqueued.jobId
      );

      if (!processResult) {
        return NextResponse.json(
          buildInboundIntegrationResponse({
            eventType,
            message_id: messageIdForLookup,
            contactId: webhookContactId,
            status: "failed",
            verificationMode,
            job_id: enqueued.jobId,
            error: "webhook_job_claim_failed",
            legacyFields,
          }),
          { status: 503 }
        );
      }

      if (processResult.skipped) {
        return NextResponse.json(
          buildInboundIntegrationResponse({
            eventType,
            message_id: processResult.message_id ?? messageIdForLookup,
            contactId: webhookContactId,
            status: "skipped",
            verificationMode,
            job_id: enqueued.jobId,
            skipReason: processResult.skipReason,
            legacyFields,
          }),
          { status: 200 }
        );
      }

      if (processResult.jobStatus === "failed") {
        return NextResponse.json(
          buildInboundIntegrationResponse({
            eventType,
            message_id: processResult.message_id ?? messageIdForLookup,
            contactId: processResult.contactId ?? webhookContactId,
            status: "failed",
            verificationMode,
            job_id: enqueued.jobId,
            error: processResult.error,
            legacyFields,
          }),
          { status: 503 }
        );
      }

      return NextResponse.json(
        buildInboundIntegrationResponse({
          eventType,
          message_id: processResult.message_id ?? messageIdForLookup,
          contactId: processResult.contactId ?? webhookContactId,
          status: "processed",
          conversation_id: processResult.conversation_id,
          inbound_message_id: processResult.inbound_message_id,
          inbound_event_id: processResult.inbound_event_id,
          verificationMode,
          job_id: enqueued.jobId,
          legacyFields,
        }),
        { status: 200 }
      );
    }

    scheduleInboundJob(enqueued.jobId);

    return NextResponse.json(
      buildInboundIntegrationResponse({
        eventType,
        message_id: messageIdForLookup,
        contactId: webhookContactId,
        status: "queued",
        verificationMode,
        job_id: enqueued.jobId,
        legacyFields,
      }),
      { status: 200 }
    );
  }

  if (externalId) {
    maybeWarnMissingExternalId(options.route, logCtx);

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
      emitFinalWebhookLog(options.route, logCtx, {
        queued: false,
        externalIdPresent: true,
        reconciled: false,
        reason: "reconcile_error",
      });
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

      emitFinalWebhookLog(options.route, logCtx, {
        queued: false,
        externalIdPresent: true,
        reconciled: true,
      });

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
      emitFinalWebhookLog(options.route, logCtx, {
        queued: false,
        externalIdPresent: true,
        reconciled: false,
        reason: "legacy_update_error",
      });
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

    const reconciled = !!legacyUpdateData;

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

    emitFinalWebhookLog(options.route, logCtx, {
      queued: false,
      externalIdPresent: true,
      reconciled,
    });

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

  maybeWarnMissingExternalId(options.route, logCtx);

  const ignoredReason = options.legacyRoute
    ? "not_inbound_event"
    : "not_inbound_or_delivery";

  emitFinalWebhookLog(options.route, logCtx, {
    queued: false,
    ignored: true,
    reason: ignoredReason,
  });

  return NextResponse.json(
    {
      ...legacyFields,
      received: true,
      event_stored: !insertError,
      message_updated: false,
      lead_updated: false,
      status,
      ...(options.legacyRoute ? { ignored: true, reason: ignoredReason } : {}),
    },
    { status: 200 }
  );
}
