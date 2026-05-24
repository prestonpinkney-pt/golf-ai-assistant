import type { SupabaseClient } from "@supabase/supabase-js";

/** Best-effort throttling — identical delivery errors spam logs every webhook tick. */
const recentDeliveryWarns = new Map<string, number>();
const DELIVERY_WARN_DEDupe_MS = 60_000;

function shouldLogDeliveryWarn(key: string): boolean {
  const now = Date.now();
  const prev = recentDeliveryWarns.get(key);
  if (prev && now - prev < DELIVERY_WARN_DEDupe_MS) return false;
  recentDeliveryWarns.set(key, now);
  return true;
}

function isMissingDeliveryUpdatedAtColumn(errorMessage: string): boolean {
  return (
    /\bdelivery_updated_at\b/i.test(errorMessage) &&
    /\b(schema cache|could not find|column)\b/i.test(errorMessage)
  );
}

function sentDmProviderMessageIdOrFilter(providerMessageId: string): string {
  return [
    `external_id.eq.${providerMessageId}`,
    `provider_message_id.eq.${providerMessageId}`,
    `metadata->>provider_message_id.eq.${providerMessageId}`,
    `metadata->>sentdm_message_id.eq.${providerMessageId}`,
    `metadata->>sentdmMessageId.eq.${providerMessageId}`,
  ].join(",");
}

export type ReconcileMessageDeliveryPatchResult = {
  appliedWithTimestampColumn: boolean;
  errorMessage: string | null;
  matchedMessage: { id: string; conversation_id: string | null } | null;
};

/**
 * Applies Sent.dm-derived delivery timestamps to outbound message rows without hard-failing
 * when Postgres is missing newer columns (partial migrations / stale cache).
 */
export async function reconcileMessageDeliveryPatch(
  supabase: SupabaseClient,
  input: {
    externalIdTrimmed: string;
    deliveryStatus: string;
    /** ISO timestamp pushed when `delivery_updated_at` exists server-side */
    touchedAtIso: string;
  }
): Promise<ReconcileMessageDeliveryPatchResult> {
  const patchFull = {
    delivery_status: input.deliveryStatus,
    delivery_updated_at: input.touchedAtIso,
    status: input.deliveryStatus,
  };

  const firstAttempt = await supabase
    .from("messages")
    .update(patchFull)
    .eq("direction", "outbound")
    .or(sentDmProviderMessageIdOrFilter(input.externalIdTrimmed))
    .select("id, conversation_id")
    .maybeSingle();

  const { data, error } = firstAttempt;

  if (!error)
    return {
      appliedWithTimestampColumn: true,
      errorMessage: null,
      matchedMessage: data ? {
        id: String((data as { id: unknown }).id),
        conversation_id:
          typeof (data as { conversation_id?: unknown }).conversation_id === "string" ?
            (data as { conversation_id: string }).conversation_id
          : null,
      } : null,
    };

  if (
    input.externalIdTrimmed &&
    !isMissingDeliveryUpdatedAtColumn(error.message) &&
    shouldLogDeliveryWarn(`messages:${input.externalIdTrimmed}:${error.message.slice(0, 120)}`)
  ) {
    console.warn("[delivery-status] outbound messages update:", error.message);
  }

  if (!isMissingDeliveryUpdatedAtColumn(error.message)) {
    return { appliedWithTimestampColumn: false, errorMessage: error.message, matchedMessage: null };
  }

  const patchMinimal = {
    delivery_status: input.deliveryStatus,
    status: input.deliveryStatus,
  };

  const retry = await supabase
    .from("messages")
    .update(patchMinimal)
    .eq("direction", "outbound")
    .or(sentDmProviderMessageIdOrFilter(input.externalIdTrimmed))
    .select("id, conversation_id")
    .maybeSingle();

  if (retry.error) {
    if (shouldLogDeliveryWarn(`fallback:${retry.error.message.slice(0, 140)}`)) {
      console.warn("[delivery-status] fallback outbound update:", retry.error.message);
    }
    return { appliedWithTimestampColumn: false, errorMessage: retry.error.message, matchedMessage: null };
  }

  if (shouldLogDeliveryWarn(`missing_delivery_updated_at_migration`)) {
    console.warn(
      "[delivery-status] delivery_updated_at column missing/failed schema cache — retried without it. Apply messages migration adding delivery_updated_at (see supabase/migrations)."
    );
  }

  return {
    appliedWithTimestampColumn: false,
    errorMessage: null,
    matchedMessage: retry.data ? {
      id: String((retry.data as { id: unknown }).id),
      conversation_id:
        typeof (retry.data as { conversation_id?: unknown }).conversation_id === "string" ?
          (retry.data as { conversation_id: string }).conversation_id
        : null,
    } : null,
  };
}
