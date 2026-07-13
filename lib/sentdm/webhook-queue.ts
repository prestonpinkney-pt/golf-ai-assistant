import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { computeWebhookJobDedupeKey } from "@/lib/sentdm/webhook-job-dedupe";

export type SentDmWebhookJobIngestSource =
  | "sentdm_webhook"
  | "sentdm_inbound_route";

const STALE_PROCESSING_MS = 15 * 60 * 1000;
const MAX_WEBHOOK_JOB_ATTEMPTS = 5;

type ExistingWebhookJob = {
  id: string;
  status: string | null;
  updated_at: string | null;
  attempts: number | null;
};

function isStaleProcessingJob(job: ExistingWebhookJob): boolean {
  if (job.status !== "processing") return false;
  if (!job.updated_at) return true;
  const updatedAt = Date.parse(job.updated_at);
  if (!Number.isFinite(updatedAt)) return true;
  return Date.now() - updatedAt > STALE_PROCESSING_MS;
}

function shouldRetryDuplicateJob(job: ExistingWebhookJob): boolean {
  const attempts = job.attempts ?? 0;
  if (attempts >= MAX_WEBHOOK_JOB_ATTEMPTS) return false;
  return (
    job.status === "pending" ||
    job.status === "failed" ||
    isStaleProcessingJob(job)
  );
}

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
      .select("id, status, updated_at, attempts")
      .eq("provider", "sentdm")
      .eq("external_id", external_id)
      .maybeSingle();

    if (lookupError) {
      return { ok: false, error: lookupError.message };
    }

    const existingJob = existing as ExistingWebhookJob | null;
    if (!existingJob || !shouldRetryDuplicateJob(existingJob)) {
      return { ok: true, duplicate: true };
    }

    const { data: requeued, error: requeueError } = await supabase
      .from("webhook_jobs")
      .update({
        payload: input.payload,
        event_type: input.eventType,
        metadata: row.metadata,
        status: "pending",
        processed_at: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingJob.id)
      .select("id")
      .maybeSingle();

    if (requeueError) {
      return { ok: false, error: requeueError.message };
    }

    return {
      ok: true,
      jobId: (requeued?.id as string | undefined) ?? existingJob.id,
      duplicate: false,
    };
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
