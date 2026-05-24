import type { SupabaseClient } from "@supabase/supabase-js";

export async function logMessagingAudit(
  supabase: SupabaseClient,
  input: {
    event_type: string;
    entity_type: string;
    entity_id?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  await supabase.from("audit_logs").insert({
    event_type: input.event_type,
    entity_type: input.entity_type,
    entity_id: input.entity_id ?? null,
    metadata: input.metadata ?? {},
  });
}
