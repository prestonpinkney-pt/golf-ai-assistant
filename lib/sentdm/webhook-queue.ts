import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { computeWebhookJobDedupeKey } from "@/lib/sentdm/webhook-job-dedupe";

export type SentDmWebhookJobIngestSource =
  | "sentdm_webhook"
  | "sentdm_inbound_route";

export async function enqueueSentDmInboundWebhookJob(
  supabase: SupabaseClient,
  input: {
    payload: Record<string, unknown>;
    eventType: string;
    ingestSource: SentDmWebhookJobIngestSource;
  }
): Promise<
  | { ok: true; jobId: string; duplicate: false }
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
    if (!external_id) {
      return { ok: true, duplicate: true };
    }

    const { data: existing, error: lookupError } = await supabase
      .from("webhook_jobs")
      .select("id,status")
      .eq("provider", "sentdm")
      .eq("external_id", external_id)
      .maybeSingle();

    if (lookupError) {
      return {
        ok: false,
        error: `webhook_jobs_duplicate_lookup_failed: ${lookupError.message}`,
      };
    }

    const existingJob = existing as
      | { id?: string | null; status?: string | null }
      | null;

    if (existingJob?.id && existingJob.status === "failed") {
      const { data: requeued, error: requeueError } = await supabase
        .from("webhook_jobs")
        .update({
          event_type: input.eventType,
          payload: input.payload,
          metadata: { ingest_source: input.ingestSource, requeued_from_failed: true },
          status: "pending",
          last_error: null,
          processed_at: null,
        })
        .eq("id", existingJob.id)
        .select("id")
        .maybeSingle();

      if (requeueError) {
        return {
          ok: false,
          error: `webhook_jobs_failed_duplicate_requeue_failed: ${requeueError.message}`,
        };
      }

      const requeuedJobId = requeued?.id as string | undefined;
      if (!requeuedJobId) {
        return { ok: false, error: "webhook_jobs_requeue_missing_id" };
      }

      return { ok: true, jobId: requeuedJobId, duplicate: false };
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
