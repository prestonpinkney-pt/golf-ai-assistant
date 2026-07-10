import { NextRequest, NextResponse } from "next/server";

import {
  sentDmWebhookSignatureHeaderPresence,
  verifySentDmAuthenticity,
} from "@/lib/messaging/sentdm-webhook";
import { handleSentDmWebhookPost } from "@/lib/sentdm/handle-webhook-post";

/**
 * Legacy Sent.dm webhook alias.
 *
 * Keep this route wired to the canonical queue/enrichment pipeline so old
 * dashboard URLs handle production `payload.message_id` envelopes correctly.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const headerDiag = sentDmWebhookSignatureHeaderPresence(req);

  const verification = verifySentDmAuthenticity(req, rawBody);
  if (!verification.ok) {
    console.warn(
      `[webhooks/sent] Rejected: ${verification.reason}; headers_present=`,
      headerDiag
    );
    return NextResponse.json(
      {
        error: "Unauthorized",
        reason: verification.reason,
        verificationMode: "rejected",
        legacy_route: true,
        canonical_route: "/api/sentdm/webhook",
      },
      { status: 401 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    console.error("[webhooks/sent] Invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  return handleSentDmWebhookPost(body, verification, {
    route: "webhooks/sent",
    webhookEventSource: "sentdm_legacy",
    ingestSource: "sentdm_webhook",
    legacyRoute: true,
  });
}
