import { NextRequest, NextResponse } from "next/server";

import {
  extractSentDmContactId,
  extractSentDmMessageIdForLookup,
  sentDmWebhookSignatureHeaderPresence,
  verifySentDmAuthenticity,
} from "@/lib/messaging/sentdm-webhook";
import { handleSentDmWebhookPost } from "@/lib/sentdm/handle-webhook-post";

/**
 * CloseOS — Sent.dm Webhook Receiver
 * POST /api/sentdm/webhook
 *
 * Production / integration testing:
 * - Requires HMAC-SHA256 when `SENTDM_WEBHOOK_SECRET` is set (see `verifySentDmAuthenticity`).
 * - Real `message.received` payloads with `payload.message_id` run GET /v3/messages/{id},
 *   then synchronously persist inbound → conversations/messages/inbound_events.
 * - Returns `{ eventType, message_id, contactId, status: "processed" | "queued" | ... }`.
 *
 * Local unsigned smoke only: `SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS=true` (development).
 *
 * Env: `SENTDM_WEBHOOK_SECRET`, `SENTDM_API_KEY` (or `SENT_API_KEY` / `SENT_DM_API_KEY`),
 * `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
 */

function normalizedEventType(body: Record<string, unknown>): string {
  return String(
    body.sub_type ?? body.subtype ?? body.event ?? body.type ?? "unknown"
  );
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const headerDiag = sentDmWebhookSignatureHeaderPresence(req);

  const verification = verifySentDmAuthenticity(req, rawBody);
  if (!verification.ok) {
    console.warn(
      `[sentdm/webhook] Rejected: ${verification.reason}; headers_present=`,
      headerDiag
    );
    return NextResponse.json(
      {
        error: "Unauthorized",
        reason: verification.reason,
        verificationMode: "rejected",
      },
      { status: 401 }
    );
  }

  if (
    verification.mode === "hmac_sha256_body" ||
    verification.mode === "shared_secret_header"
  ) {
    console.info(
      `[sentdm/webhook] Verified webhook (verificationMode: ${verification.mode}).`
    );
  } else if (verification.mode === "development_unsigned_allowed") {
    console.warn(
      `[sentdm/webhook] Unsigned dev smoke only (verificationMode: ${verification.mode}). ` +
        "Use signed webhooks with payload.message_id for integration testing."
    );
  } else if (verification.mode === "development_no_secret") {
    console.warn(
      `[sentdm/webhook] No SENTDM_WEBHOOK_SECRET configured (verificationMode: ${verification.mode}).`
    );
  }

  let body: Record<string, unknown>;
  try {
    body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    console.error("[sentdm/webhook] Invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const eventType = normalizedEventType(body);
  const messageId = extractSentDmMessageIdForLookup(body);
  const contactId = extractSentDmContactId(body);

  if (messageId) {
    console.info(
      `[sentdm/webhook] Inbound integration envelope eventType=${eventType} message_id=${messageId}` +
        (contactId ? ` contactId=${contactId}` : "")
    );
  }

  return handleSentDmWebhookPost(body, verification, {
    route: "sentdm/webhook",
    webhookEventSource: "sentdm",
    ingestSource: "sentdm_webhook",
  });
}

export async function GET() {
  const secretConfigured = Boolean(process.env.SENTDM_WEBHOOK_SECRET?.trim());
  return NextResponse.json(
    {
      status: "ok",
      handler: "sentdm-webhook",
      signature_required: secretConfigured,
      unsigned_dev_allowed:
        process.env.NODE_ENV === "development" &&
        process.env.SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS?.trim().toLowerCase() ===
          "true",
      integration_hint:
        "POST signed message.received with payload.message_id for full Sent.dm lookup + status processed.",
    },
    { status: 200 }
  );
}
