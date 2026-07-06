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
    if (external_id) {
      const requeued = await requeueFailedSentDmWebhookJob(
        supabase,
        external_id,
        row
      );
      if (requeued.ok) {
        return {
          ok: true,
          jobId: requeued.jobId,
          duplicate: false,
          requeued: true,
        };
      }
      if (requeued.error) {
        return { ok: false, error: requeued.error };
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

async function requeueFailedSentDmWebhookJob(
  supabase: SupabaseClient,
  externalId: string,
  row: {
    provider: string;
    event_type: string;
    external_id: string | null;
    payload: Record<string, unknown>;
    metadata: { ingest_source: SentDmWebhookJobIngestSource };
    status: string;
  }
): Promise<
  | { ok: true; jobId: string }
  | { ok: false; duplicate: true }
  | { ok: false; error: string }
> {
  const { data, error } = await supabase
    .from("webhook_jobs")
    .update({
      ...row,
      status: "pending",
      last_error: null,
      processed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("provider", "sentdm")
    .eq("external_id", externalId)
    .eq("status", "failed")
    .select("id")
    .maybeSingle();

  if (error) {
    return { ok: false, error: error.message };
  }

  const jobId = data?.id as string | undefined;
  if (!jobId) {
    return { ok: false, duplicate: true };
  }

  return { ok: true, jobId };
}
