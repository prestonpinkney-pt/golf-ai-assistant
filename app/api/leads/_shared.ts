import { supabaseAdmin } from "@/lib/supabase/admin";

export type LeadStatus = "open" | "contacted" | "booked" | "closed";

type LeadRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  message: string | null;
  source: string | null;
  lead_type: string | null;
  status: string | null;
  follow_up_count: number | null;
  preferred_contact_channel: string | null;
  last_contacted_at: string | null;
  created_at: string | null;
  ai_summary: string | null;
  ai_next_best_action: string | null;
  ai_last_reasoning: string | null;
};

export const VALID_LEAD_STATUSES: LeadStatus[] = [
  "open",
  "contacted",
  "booked",
  "closed",
];

export function normalizeLeadStatus(value: string | null): LeadStatus {
  if (!value) return "open";
  if (value === "new") return "open";
  if (value === "active") return "contacted";
  if (VALID_LEAD_STATUSES.includes(value as LeadStatus)) {
    return value as LeadStatus;
  }
  return "open";
}

function inferPrimaryIntent(lead: LeadRow) {
  const type = (lead.lead_type ?? "").toLowerCase();
  if (type.includes("lesson")) return "lesson";
  if (type.includes("event")) return "event";
  if (type.includes("membership") || type.includes("member")) return "membership";
  if (type.includes("tee")) return "tee_time";

  const message = (lead.message ?? "").toLowerCase();
  if (message.includes("lesson")) return "lesson";
  if (message.includes("event")) return "event";
  if (message.includes("member")) return "membership";
  if (message.includes("tee")) return "tee_time";
  return "general";
}

export function toInboxLead(lead: LeadRow) {
  const primaryIntent = inferPrimaryIntent(lead);
  const followUpCount = lead.follow_up_count ?? 0;

  return {
    id: lead.id,
    name: lead.full_name ?? "",
    phone: lead.phone ?? "",
    email: lead.email ?? "",
    preferredChannel: lead.preferred_contact_channel ?? "sms",
    message: lead.message ?? "",
    reply: lead.ai_next_best_action ?? "",
    intents: [primaryIntent],
    primaryIntent,
    secondaryIntents: [],
    complexity: "medium",
    leadTemperature: "warm",
    persona: "unknown",
    pressureMode: "normal",
    goal: "book",
    shouldEscalate: false,
    status: normalizeLeadStatus(lead.status),
    statusReason: lead.ai_last_reasoning ?? "",
    followUpCount,
    followUpMessage: lead.ai_next_best_action ?? "",
    nextFollowUpAt: null,
    lastFollowUpAt: null,
    lastContactedAt: lead.last_contacted_at,
    lastSendChannel: lead.preferred_contact_channel ?? "",
    lastSendResult: "",
    createdAt: lead.created_at ?? "",
  };
}

export async function fetchLeadById(id: string) {
  const { data, error } = await supabaseAdmin
    .from("leads")
    .select(
      "id, full_name, phone, email, message, source, lead_type, status, follow_up_count, preferred_contact_channel, last_contacted_at, created_at, ai_summary, ai_next_best_action, ai_last_reasoning"
    )
    .eq("id", id)
    .single();

  if (error || !data) return null;
  return data as LeadRow;
}
