import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { computeWebhookJobDedupeKey } from "@/lib/sentdm/webhook-job-dedupe";

export type SentDmWebhookJobIngestSource =
  | "sentdm_webhook"
  | "sentdm_inbound_route";

async function requeueFailedDuplicateWebhookJob(
  supabase: SupabaseClient,
  externalId: string
): Promise<string | null> {
  const iso = new Date().toISOString();
  const { data, error } = await supabase
    .from("webhook_jobs")
    .update({
      status: "pending",
      last_error: null,
      processed_at: null,
      updated_at: iso,
    })
    .eq("external_id", externalId)
    .eq("status", "failed")
    .select("id")
    .maybeSingle();

  if (error) {
    console.warn("[webhook-jobs] failed duplicate requeue:", error.message);
    return null;
  }

  return typeof data?.id === "string" ? data.id : null;
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
    if (external_id) {
      const jobId = await requeueFailedDuplicateWebhookJob(
        supabase,
        external_id
      );
      if (jobId) {
        return { ok: true, jobId, duplicate: false };
      }
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
