import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { computeWebhookJobDedupeKey } from "@/lib/sentdm/webhook-job-dedupe";

export type SentDmWebhookJobIngestSource =
  | "sentdm_webhook"
  | "sentdm_inbound_route";

export type EnqueuedSentDmWebhookJob =
  | { ok: true; jobId: string; duplicate: false }
  | {
      ok: true;
      duplicate: true;
      jobId: string | null;
      jobStatus: string | null;
    }
  | { ok: false; error: string };

export async function enqueueSentDmInboundWebhookJob(
  supabase: SupabaseClient,
  input: {
    payload: Record<string, unknown>;
    eventType: string;
    ingestSource: SentDmWebhookJobIngestSource;
  }
): Promise<EnqueuedSentDmWebhookJob> {
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
      return { ok: true, duplicate: true, jobId: null, jobStatus: null };
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
      console.warn(
        "[webhook_jobs] duplicate lookup failed:",
        lookupError.message
      );
      return { ok: true, duplicate: true, jobId: null, jobStatus: null };
    }

    return {
      ok: true,
      duplicate: true,
      jobId: typeof existing?.id === "string" ? existing.id : null,
      jobStatus: typeof existing?.status === "string" ? existing.status : null,
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
