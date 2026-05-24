/**
 * Pure helpers for webhook job dedupe keys (safe for tests — no server-only).
 */

import { extractSentDmMessageExternalId } from "@/lib/messaging/sentdm-webhook";
import { firstString } from "@/lib/messaging/webhook-payload";

/** Dedupe key for `webhook_jobs.external_id` (unique when non-null). */
export function computeWebhookJobDedupeKey(
  body: Record<string, unknown>
): string | null {
  const mid =
    extractSentDmMessageExternalId(body) ??
    firstString(body, ["payload.message_id", "payload.messageId"]);
  if (mid?.trim()) return `sentdm:${mid.trim()}`;

  const evt =
    firstString(body, ["id", "event_id", "webhook_id", "payload.id"]) ?? null;
  if (evt?.trim()) return `sentdm:event:${evt.trim()}`;

  return null;
}
