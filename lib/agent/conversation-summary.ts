import "server-only";

import OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";

const SUMMARY_MODEL =
  process.env.CLOSEOS_SUMMARY_MODEL?.trim() ||
  process.env.CLOSEOS_AGENT_MODEL?.trim() ||
  "gpt-4o-mini";

function minSecondsBetweenSummaries(): number {
  const n = Number(process.env.CLOSEOS_CONVERSATION_SUMMARY_MIN_SECONDS);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export type ConversationSummaryUpdateResult =
  | { ok: true; updated: boolean; reason?: string }
  | { ok: false; error: string };

function formatMessages(
  rows: {
    direction: string | null;
    message_text: string | null;
    body: string | null;
    sender_type: string | null;
    created_at: string | null;
  }[]
): string {
  return rows
    .map((m) => {
      const role =
        m.direction === "inbound"
          ? "customer"
          : m.direction === "outbound"
            ? m.sender_type === "staff"
              ? "staff"
              : "assistant"
            : (m.direction ?? "unknown");
      const txt = (m.body ?? m.message_text ?? "").trim();
      return `[${role}] ${txt}`;
    })
    .filter((line) => line.replace(/\[.*?\]\s*/, "").trim().length > 0)
    .join("\n");
}

async function fetchMessagesSince(
  supabase: SupabaseClient,
  conversationId: string,
  sinceIso: string | null,
  fallbackLimit = 40
): Promise<
  {
    direction: string | null;
    message_text: string | null;
    body: string | null;
    sender_type: string | null;
    created_at: string | null;
  }[]
> {
  if (sinceIso?.trim()?.length) {
    const { data, error } = await supabase
      .from("messages")
      .select("direction, message_text, body, sender_type, created_at")
      .eq("conversation_id", conversationId)
      .gt("created_at", sinceIso)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[conversation-summary] fetch messages:", error.message);
      return [];
    }
    return data ?? [];
  }

  const { data, error } = await supabase
    .from("messages")
    .select("direction, message_text, body, sender_type, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(fallbackLimit);

  if (error) {
    console.error("[conversation-summary] fetch messages:", error.message);
    return [];
  }
  return [...(data ?? [])].reverse();
}

/**
 * Loads messages since `summary_updated_at` (when set) or recent history, then rewrites `conversations.summary`.
 */
export async function summarizeConversation(
  supabase: SupabaseClient,
  conversationId: string
): Promise<ConversationSummaryUpdateResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "missing_openai_key" };
  }

  const { data: conversation, error: convErr } = await supabase
    .from("conversations")
    .select("id, summary, summary_updated_at")
    .eq("id", conversationId)
    .maybeSingle();

  if (convErr || !conversation?.id) {
    return {
      ok: false,
      error:
        convErr?.message ??
        ("conversation_lookup_failed_" + encodeURIComponent(conversationId)),
    };
  }

  const sinceIso =
    typeof conversation.summary_updated_at === "string"
      ? conversation.summary_updated_at
      : null;
  const rows = await fetchMessagesSince(supabase, conversationId, sinceIso);

  if (!rows.length) {
    return {
      ok: true,
      updated: false,
      reason: sinceIso ? "no_new_messages_since_summary" : "no_messages",
    };
  }

  const transcript = formatMessages(rows);

  const system = [
    "You maintain a concise factual sales/front-desk MEMORY for Primetime Golf SMS threads.",
    "Output plain text bullets or short clauses only (max ~800 characters). No small talk.",
    "Include ONLY when evidenced in the transcript: customer intent; service requested;",
    "date/time preferences; group size / headcount;",
    "pricing questions; objections; booking status;",
    "membership interest; escalation or complaints; opt-out / STOP if present.",
    "Ignore URLs and do not summarize link contents.",
    "Merge logically with Prior summary so nothing important is dropped.",
  ].join(" ");

  const openai = new OpenAI({ apiKey });
  let updatedSummaryText: string;
  try {
    const completion = await openai.chat.completions.create({
      model: SUMMARY_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify({
            prior_summary: conversation.summary ?? "",
            transcript,
          }),
        },
      ],
    });
    updatedSummaryText = (completion.choices[0]?.message?.content ?? "")
      .trim()
      .slice(0, 4000);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "openai_summarize_failed";
    return { ok: false, error: msg };
  }

  if (!updatedSummaryText.length) {
    return { ok: false, error: "empty_summary_output" };
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("conversations")
    .update({
      summary: updatedSummaryText,
      summary_updated_at: nowIso,
    })
    .eq("id", conversationId);

  if (updErr) {
    return { ok: false, error: updErr.message };
  }

  return { ok: true, updated: true };
}

/**
 * Best-effort throttled summarize. Safe to fire-and-forget from webhooks (does not block).
 */
export async function maybeUpdateConversationSummary(
  supabase: SupabaseClient,
  conversationId: string
): Promise<ConversationSummaryUpdateResult> {
  const minSec = minSecondsBetweenSummaries();
  if (minSec > 0) {
    const { data: row } = await supabase
      .from("conversations")
      .select("summary_updated_at")
      .eq("id", conversationId)
      .maybeSingle();
    const last = row?.summary_updated_at
      ? Date.parse(row.summary_updated_at as string)
      : NaN;
    if (!Number.isNaN(last)) {
      const elapsed = (Date.now() - last) / 1000;
      if (elapsed < minSec) {
        return { ok: true, updated: false, reason: "throttled_min_interval" };
      }
    }
  }

  return summarizeConversation(supabase, conversationId);
}
