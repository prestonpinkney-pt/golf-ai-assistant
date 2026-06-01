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
    if (external_id) {
      const { data: existing, error: existingError } = await supabase
        .from("webhook_jobs")
        .select("id, status")
        .eq("provider", "sentdm")
        .eq("external_id", external_id)
        .maybeSingle();

      if (existingError) {
        return { ok: false, error: existingError.message };
      }

      const existingId =
        existing && typeof existing.id === "string" ? existing.id : null;
      const existingStatus =
        existing && typeof existing.status === "string" ? existing.status : null;

      if (existingId && existingStatus === "failed") {
        const { data: recovered, error: recoverError } = await supabase
          .from("webhook_jobs")
          .update({
            payload: input.payload,
            event_type: input.eventType,
            metadata: { ingest_source: input.ingestSource },
            status: "pending",
            last_error: null,
            processed_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingId)
          .eq("status", "failed")
          .select("id")
          .maybeSingle();

        if (recoverError) {
          return { ok: false, error: recoverError.message };
        }

        const recoveredId =
          recovered && typeof recovered.id === "string" ? recovered.id : null;
        if (recoveredId) {
          return { ok: true, jobId: recoveredId, duplicate: false };
        }
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
