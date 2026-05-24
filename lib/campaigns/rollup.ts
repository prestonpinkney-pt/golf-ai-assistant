import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Recomputes denormalized counters and derives campaign.status:
 * draft | approved | sending | sent | failed
 */
export async function refreshCampaignRollup(
  supabase: SupabaseClient,
  campaignId: string
): Promise<void> {
  const { data: rows, error } = await supabase
    .from("campaign_messages")
    .select("status")
    .eq("campaign_id", campaignId);

  if (error) throw new Error(error.message);

  const list = rows ?? [];
  const n = list.length;
  const total_drafted = list.filter((r) => r.status === "draft").length;
  const total_approved = list.filter((r) => r.status === "approved").length;
  const total_sent = list.filter((r) => r.status === "sent").length;
  const total_failed = list.filter((r) => r.status === "failed").length;

  const hasDraft = list.some((r) => r.status === "draft");
  const hasApprovedPending = list.some((r) => r.status === "approved");
  const hasSending = list.some((r) => r.status === "sending");
  const anySent = total_sent > 0;
  const anyFailed = total_failed > 0;

  let status: string;
  if (hasSending) {
    status = "sending";
  } else if (hasApprovedPending) {
    status = "approved";
  } else if (hasDraft) {
    status = "draft";
  } else if (anySent) {
    status = "sent";
  } else if (anyFailed) {
    status = "failed";
  } else {
    status = "draft";
  }

  const { data: camp, error: campErr } = await supabase
    .from("campaigns")
    .select("sent_at")
    .eq("id", campaignId)
    .maybeSingle();

  if (campErr) throw new Error(campErr.message);

  const priorSentAt = (camp?.sent_at as string | null | undefined) ?? null;
  const sent_at =
    priorSentAt ?? (anySent ? new Date().toISOString() : null);

  const { error: updErr } = await supabase
    .from("campaigns")
    .update({
      total_recipients: n,
      total_drafted,
      total_approved,
      total_sent,
      total_failed,
      status,
      sent_at,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);

  if (updErr) throw new Error(updErr.message);
}
