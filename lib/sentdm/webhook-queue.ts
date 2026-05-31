import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { computeWebhookJobDedupeKey } from "@/lib/sentdm/webhook-job-dedupe";

export type SentDmWebhookJobIngestSource =
  | "sentdm_webhook"
  | "sentdm_inbound_route";

type ExistingWebhookJob = {
  id?: string | null;
  status?: string | null;
  updated_at?: string | null;
};

type SentDmWebhookJobEnqueueResult =
  | { ok: true; jobId: string; duplicate: false; reused?: boolean }
  | { ok: true; duplicate: true; jobId?: string; existingStatus?: string | null }
  | { ok: false; error: string };

const STALE_PROCESSING_MS = 15 * 60 * 1000;

export function isRetryableExistingWebhookJob(
  job: ExistingWebhookJob,
  nowMs = Date.now()
): boolean {
  if (job.status === "failed" || job.status === "pending") return true;
  if (job.status !== "processing" || !job.updated_at) return false;

  const updatedMs = Date.parse(job.updated_at);
  if (!Number.isFinite(updatedMs)) return false;
  return updatedMs < nowMs - STALE_PROCESSING_MS;
}

async function reuseExistingWebhookJob(
  supabase: SupabaseClient,
  externalId: string
): Promise<SentDmWebhookJobEnqueueResult> {
  const { data: existing, error: lookupError } = await supabase
    .from("webhook_jobs")
    .select("id,status,updated_at")
    .eq("external_id", externalId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    return { ok: false, error: lookupError.message };
  }

  const job = (existing ?? null) as ExistingWebhookJob | null;
  const jobId = typeof job?.id === "string" ? job.id : null;
  if (!jobId) {
    return { ok: true, duplicate: true };
  }

  if (!isRetryableExistingWebhookJob(job)) {
    return {
      ok: true,
      duplicate: true,
      jobId,
      existingStatus: job.status ?? null,
    };
  }

  if (job.status === "pending") {
    return { ok: true, jobId, duplicate: false, reused: true };
  }

  const updatePayload = {
    status: "pending",
    last_error: null,
    processed_at: null,
    updated_at: new Date().toISOString(),
  };
  let updateQuery = supabase
    .from("webhook_jobs")
    .update(updatePayload)
    .eq("id", jobId);

  if (job.status === "failed") {
    updateQuery = updateQuery.eq("status", "failed");
  } else {
    const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
    updateQuery = updateQuery.eq("status", "processing").lt("updated_at", staleCutoff);
  }

  const { data: updated, error: updateError } = await updateQuery
    .select("id")
    .maybeSingle();

  if (updateError) {
    return { ok: false, error: updateError.message };
  }

  const updatedId =
    updated && typeof updated === "object" && "id" in updated ?
      (updated.id as string | undefined)
    : undefined;

  if (!updatedId) {
    return {
      ok: true,
      duplicate: true,
      jobId,
      existingStatus: job.status ?? null,
    };
  }

  return { ok: true, jobId: updatedId, duplicate: false, reused: true };
}

export async function enqueueSentDmInboundWebhookJob(
  supabase: SupabaseClient,
  input: {
    payload: Record<string, unknown>;
    eventType: string;
    ingestSource: SentDmWebhookJobIngestSource;
  }
): Promise<SentDmWebhookJobEnqueueResult> {
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
    return external_id ?
        reuseExistingWebhookJob(supabase, external_id)
      : { ok: true, duplicate: true };
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
