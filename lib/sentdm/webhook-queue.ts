import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { computeWebhookJobDedupeKey } from "@/lib/sentdm/webhook-job-dedupe";

export type SentDmWebhookJobIngestSource =
  | "sentdm_webhook"
  | "sentdm_inbound_route";

export type EnqueueSentDmInboundWebhookJobResult =
  | { ok: true; jobId: string; duplicate: false; requeued: false }
  | { ok: true; jobId: string; duplicate: true; requeued: true }
  | {
      ok: true;
      jobId: string | null;
      duplicate: true;
      requeued: false;
      status: string | null;
    }
  | { ok: false; error: string };

export async function enqueueSentDmInboundWebhookJob(
  supabase: SupabaseClient,
  input: {
    payload: Record<string, unknown>;
    eventType: string;
    ingestSource: SentDmWebhookJobIngestSource;
  }
): Promise<EnqueueSentDmInboundWebhookJobResult> {
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
      return { ok: true, jobId: null, duplicate: true, requeued: false, status: null };
    }

    const { data: existing, error: lookupError } = await supabase
      .from("webhook_jobs")
      .select("id, status")
      .eq("provider", "sentdm")
      .eq("external_id", external_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lookupError) {
      return { ok: false, error: lookupError.message };
    }

    const jobId = typeof existing?.id === "string" ? existing.id : null;
    const status = typeof existing?.status === "string" ? existing.status : null;

    if (!jobId || status !== "failed") {
      return { ok: true, jobId, duplicate: true, requeued: false, status };
    }

    const { data: requeued, error: updateError } = await supabase
      .from("webhook_jobs")
      .update({
        status: "pending",
        payload: input.payload,
        event_type: input.eventType,
        metadata: { ingest_source: input.ingestSource, requeued_from_failed: true },
        last_error: null,
        processed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .select("id")
      .maybeSingle();

    if (updateError) {
      return { ok: false, error: updateError.message };
    }

    return {
      ok: true,
      jobId: typeof requeued?.id === "string" ? requeued.id : jobId,
      duplicate: true,
      requeued: true,
    };
  }

  if (error) {
    return { ok: false, error: error.message };
  }

  const jobId = data?.id as string | undefined;
  if (!jobId) {
    return { ok: false, error: "webhook_jobs_insert_missing_id" };
  }

  return { ok: true, jobId, duplicate: false, requeued: false };
}
