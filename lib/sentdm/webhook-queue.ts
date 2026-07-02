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
      const iso = new Date().toISOString();
      const { data: requeued, error: requeueError } = await supabase
        .from("webhook_jobs")
        .update({
          payload: input.payload,
          event_type: input.eventType,
          metadata: { ingest_source: input.ingestSource },
          status: "pending",
          processed_at: null,
          last_error: null,
          updated_at: iso,
        })
        .eq("provider", "sentdm")
        .eq("external_id", external_id)
        .eq("status", "failed")
        .select("id")
        .maybeSingle();

      if (requeueError) {
        return { ok: false, error: requeueError.message };
      }

      const retryJobId = requeued?.id as string | undefined;
      if (retryJobId) {
        return {
          ok: true,
          jobId: retryJobId,
          duplicate: false,
          requeued: true,
        };
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
