import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { logMessagingAudit } from "@/lib/messaging/audit";
import { reconcileMessageDeliveryPatch } from "@/lib/messaging/delivery-status-update";
import {
  extractSentDmInboundPayload,
  extractSentDmMessageExternalId,
  normalizeSentDmStatus,
} from "@/lib/messaging/sentdm-webhook";
import type { SentDmMessageDetails } from "@/lib/sentdm/get-message";
import {
  enrichSentDmInboundBody,
  recordSentDmInboundEnrichFailure,
  type EnrichSentDmInboundBodyResult,
} from "@/lib/sentdm/enrich-inbound-body";
import { runSentDmInboundConversationLoop } from "@/lib/sentdm/inbound-loop";
import type { SentDmWebhookJobIngestSource } from "@/lib/sentdm/webhook-queue";
import { textMatchesOurTemplateWrapperPrefix } from "@/lib/sentdm/sentdm-inbound-eligibility";

export type WebhookJobRow = {
  id: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
};

function ingestSourceFromJob(job: WebhookJobRow): SentDmWebhookJobIngestSource {
  const raw = job.metadata?.ingest_source;
  return raw === "sentdm_inbound_route" ?
      "sentdm_inbound_route"
    : "sentdm_webhook";
}

function isEnrichInboundSkipped(
  r: EnrichSentDmInboundBodyResult
): r is Extract<EnrichSentDmInboundBodyResult, { inboundSkipped: true }> {
  return !r.ok && "inboundSkipped" in r && r.inboundSkipped === true;
}

async function reconcileOutboundDeliveryFromLookup(
  supabase: SupabaseClient,
  messageId: string | null,
  details?: SentDmMessageDetails
) {
  if (!messageId?.trim() || !details?.statusRaw?.trim()) return;
  const normalized = normalizeSentDmStatus(details.statusRaw);
  const touchedAtIso = new Date().toISOString();
  const id = messageId.trim();

  await reconcileMessageDeliveryPatch(supabase, {
    externalIdTrimmed: id,
    deliveryStatus: normalized,
    touchedAtIso,
  });
}

async function outboundExistsForProviderMessageId(
  supabase: SupabaseClient,
  messageId: string
): Promise<boolean> {
  const id = messageId.trim();
  const { data, error } = await supabase
    .from("messages")
    .select("id")
    .eq("direction", "outbound")
    .or(
      [
        `external_id.eq.${id}`,
        `provider_message_id.eq.${id}`,
        `metadata->>provider_message_id.eq.${id}`,
        `metadata->>sentdm_message_id.eq.${id}`,
        `metadata->>sentdmMessageId.eq.${id}`,
      ].join(",")
    )
    .maybeSingle();
  if (error) {
    console.warn("[webhook-jobs] outbound lookup:", error.message);
    return false;
  }
  return !!data?.id;
}

function truncateErr(message: string, max = 2000): string {
  if (message.length <= max) return message;
  return `${message.slice(0, max)}…`;
}

async function finalizeJob(
  supabase: SupabaseClient,
  jobId: string,
  patch: {
    status: "completed" | "failed";
    last_error?: string | null;
  }
) {
  const iso = new Date().toISOString();
  await supabase
    .from("webhook_jobs")
    .update({
      status: patch.status,
      processed_at: iso,
      last_error:
        patch.status === "failed" ?
          truncateErr(patch.last_error ?? "unknown_error")
        : null,
      updated_at: iso,
    })
    .eq("id", jobId);
}

/**
 * Runs enrich → conversational loop for one claimed `webhook_jobs` row (`processing`).
 */
export async function runQueuedSentDmInboundJob(
  supabase: SupabaseClient,
  job: WebhookJobRow
): Promise<void> {
  const ingestSource = ingestSourceFromJob(job);

  await logMessagingAudit(supabase, {
    event_type: "webhook_job_started",
    entity_type: "webhook_job",
    entity_id: job.id,
    metadata: { ingest_source: ingestSource },
  });

  try {
    const enrich = await enrichSentDmInboundBody(job.payload);

    if (isEnrichInboundSkipped(enrich)) {
      await logMessagingAudit(supabase, {
        event_type: "sentdm_non_inbound_message_ignored",
        entity_type: "messaging",
        entity_id: enrich.messageId,
        metadata: {
          reason: enrich.reason,
          webhook_job_id: job.id,
          has_lookup_details: Boolean(enrich.details),
        },
      });
      await reconcileOutboundDeliveryFromLookup(
        supabase,
        enrich.messageId,
        enrich.details
      );
      await finalizeJob(supabase, job.id, { status: "completed" });
      await logMessagingAudit(supabase, {
        event_type: "webhook_job_completed",
        entity_type: "webhook_job",
        entity_id: job.id,
        metadata: {
          ingest_source: ingestSource,
          skipped_inbound: true,
          reason: enrich.reason,
        },
      });
      return;
    }

    if (!enrich.ok) {
      await recordSentDmInboundEnrichFailure(supabase, {
        rawBody: job.payload,
        error: enrich.error,
        messageId: enrich.messageId,
      });
      await finalizeJob(supabase, job.id, {
        status: "failed",
        last_error: enrich.error,
      });
      await logMessagingAudit(supabase, {
        event_type: "webhook_job_failed",
        entity_type: "webhook_job",
        entity_id: job.id,
        metadata: {
          stage: "enrich",
          error: enrich.error,
          message_id: enrich.messageId,
        },
      });
      return;
    }

    const workBody = enrich.body;
    const externalId = extractSentDmMessageExternalId(workBody);
    const parsed = extractSentDmInboundPayload(workBody);
    const msgText = parsed.messageText?.trim() ?? "";

    if (
      externalId &&
      msgText &&
      textMatchesOurTemplateWrapperPrefix(msgText) &&
      (await outboundExistsForProviderMessageId(supabase, externalId))
    ) {
      await logMessagingAudit(supabase, {
        event_type: "sentdm_non_inbound_message_ignored",
        entity_type: "messaging",
        entity_id: externalId,
        metadata: {
          reason: "template_wrapper_existing_outbound",
          webhook_job_id: job.id,
        },
      });
      await finalizeJob(supabase, job.id, { status: "completed" });
      await logMessagingAudit(supabase, {
        event_type: "webhook_job_completed",
        entity_type: "webhook_job",
        entity_id: job.id,
        metadata: {
          ingest_source: ingestSource,
          skipped_inbound: true,
          reason: "template_wrapper_existing_outbound",
        },
      });
      return;
    }

    const loopResult = await runSentDmInboundConversationLoop({
      supabase,
      rawPayload: workBody,
      externalId: externalId?.trim()?.length ? externalId : null,
      ingestSource,
    });

    if (!loopResult.ok) {
      await finalizeJob(supabase, job.id, {
        status: "failed",
        last_error: JSON.stringify(loopResult.body),
      });
      await logMessagingAudit(supabase, {
        event_type: "webhook_job_failed",
        entity_type: "webhook_job",
        entity_id: job.id,
        metadata: {
          stage: "inbound_loop",
          http_status: loopResult.statusCode,
          body: loopResult.body,
        },
      });
      return;
    }

    await finalizeJob(supabase, job.id, { status: "completed" });
    await logMessagingAudit(supabase, {
      event_type: "webhook_job_completed",
      entity_type: "webhook_job",
      entity_id: job.id,
      metadata: {
        ingest_source: ingestSource,
        inbound_status: loopResult.statusCode,
      },
    });
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : String(error ?? "unknown_throw");
    await finalizeJob(supabase, job.id, {
      status: "failed",
      last_error: msg,
    });
    await logMessagingAudit(supabase, {
      event_type: "webhook_job_failed",
      entity_type: "webhook_job",
      entity_id: job.id,
      metadata: { stage: "throw", error: msg },
    });
  }
}

function normalizeRpcJobRows(data: unknown): WebhookJobRow[] {
  if (!data) return [];
  const arr = Array.isArray(data) ? data : [data];
  return arr
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      id: String(r.id),
      payload:
        r.payload && typeof r.payload === "object" ?
          (r.payload as Record<string, unknown>)
        : {},
      metadata:
        r.metadata && typeof r.metadata === "object" ?
          (r.metadata as Record<string, unknown>)
        : {},
    }));
}

/** Pending → processing for one job id (via RPC); then runs pipeline. */
export async function processSentDmWebhookJobFromPending(
  supabase: SupabaseClient,
  jobId: string
): Promise<void> {
  const { data, error } = await supabase.rpc("begin_webhook_job", {
    p_id: jobId,
  });

  if (error) {
    console.warn("[webhook-jobs] begin_webhook_job RPC:", error.message);
    return;
  }

  const rows = normalizeRpcJobRows(data);
  const row = rows[0];
  if (!row) {
    return;
  }

  await runQueuedSentDmInboundJob(supabase, row);
}

/** Drain helper for cron — rows are already `processing`. */
export async function runClaimedSentDmInboundWebhookJobs(
  supabase: SupabaseClient,
  jobs: WebhookJobRow[]
): Promise<void> {
  for (const j of jobs) {
    await runQueuedSentDmInboundJob(supabase, j);
  }
}

/** Claims up to `limit` pending jobs and processes each (RPC). */
export async function claimAndProcessSentDmWebhookJobs(
  supabase: SupabaseClient,
  limit = 10
): Promise<number> {
  const { data, error } = await supabase.rpc("claim_webhook_jobs_batch", {
    p_limit: limit,
  });

  if (error) {
    console.warn("[webhook-jobs] claim_webhook_jobs_batch:", error.message);
    return 0;
  }

  const rows = normalizeRpcJobRows(data);
  await runClaimedSentDmInboundWebhookJobs(supabase, rows);
  return rows.length;
}
