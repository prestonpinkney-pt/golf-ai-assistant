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
      return { ok: false, error: "webhook_jobs_duplicate_missing_dedupe_key" };
    }

    const existing = await supabase
      .from("webhook_jobs")
      .select("id, status")
      .eq("provider", "sentdm")
      .eq("external_id", external_id)
      .maybeSingle();

    if (existing.error) {
      return { ok: false, error: existing.error.message };
    }

    if (!existing.data?.id || existing.data.status !== "failed") {
      return { ok: true, duplicate: true };
    }

    const requeued = await supabase
      .from("webhook_jobs")
      .update({
        event_type: input.eventType,
        payload: input.payload,
        metadata: { ingest_source: input.ingestSource },
        status: "pending",
        last_error: null,
        processed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.data.id)
      .eq("status", "failed")
      .select("id")
      .maybeSingle();

    if (requeued.error) {
      return { ok: false, error: requeued.error.message };
    }

    if (!requeued.data?.id) {
      return { ok: true, duplicate: true };
    }

    return { ok: true, jobId: String(requeued.data.id), duplicate: false };
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
