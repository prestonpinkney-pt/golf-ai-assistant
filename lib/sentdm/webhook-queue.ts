import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { computeWebhookJobDedupeKey } from "@/lib/sentdm/webhook-job-dedupe";

export type SentDmWebhookJobIngestSource =
  | "sentdm_webhook"
  | "sentdm_inbound_route";

async function requeueFailedDuplicateWebhookJob(
  supabase: SupabaseClient,
  input: {
    externalId: string | null;
    payload: Record<string, unknown>;
    eventType: string;
    ingestSource: SentDmWebhookJobIngestSource;
  }
): Promise<{ jobId: string } | null> {
  if (!input.externalId) return null;

  const { data, error } = await supabase
    .from("webhook_jobs")
    .update({
      event_type: input.eventType,
      payload: input.payload,
      metadata: { ingest_source: input.ingestSource },
      status: "pending",
      processed_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("provider", "sentdm")
    .eq("external_id", input.externalId)
    .eq("status", "failed")
    .select("id")
    .maybeSingle();

  if (error) {
    console.warn("[webhook-jobs] failed duplicate requeue:", error.message);
    return null;
  }

  const jobId = data?.id as string | undefined;
  return jobId ? { jobId } : null;
}

export async function enqueueSentDmInboundWebhookJob(
  supabase: SupabaseClient,
  input: {
    payload: Record<string, unknown>;
    eventType: string;
    ingestSource: SentDmWebhookJobIngestSource;
  }
): Promise<
  | { ok: true; jobId: string; duplicate: false; requeued?: boolean }
  | { ok: true; duplicate: true }
  | { ok: false; error: string }
> {
  const external_id = computeWebhookJobDedupeKey(input.payload);
  const row = {
    provider: "sentdm",
    event_type: input.eventType,
    external_id,
    payload: input.payload,
    metadata: { ingest_source: input.ingestSource },
    status: "pending",
  };

  const { data, error } = await supabase
    .from("webhook_jobs")
    .insert(row)
    .select("id")
    .maybeSingle();

  if (error?.code === "23505") {
    const requeued = await requeueFailedDuplicateWebhookJob(supabase, {
      externalId: external_id,
      payload: input.payload,
      eventType: input.eventType,
      ingestSource: input.ingestSource,
    });

    if (requeued) {
      return {
        ok: true,
        jobId: requeued.jobId,
        duplicate: false,
        requeued: true,
      };
    }

    return { ok: true, duplicate: true };
  }

  if (error) {
    return { ok: false, error: error.message };
  }

  const jobId = data?.id as string | undefined;
  if (!jobId) {
    return { ok: false, error: "webhook_jobs_insert_missing_id" };
  }

  return { ok: true, jobId, duplicate: false };
}
