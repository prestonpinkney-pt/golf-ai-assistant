import { NextRequest, NextResponse } from "next/server";

import {
  extractSentDmContactId,
  extractSentDmMessageIdForLookup,
  sentDmWebhookSignatureHeaderPresence,
  verifySentDmAuthenticity,
} from "@/lib/messaging/sentdm-webhook";
import { handleSentDmWebhookPost } from "@/lib/sentdm/handle-webhook-post";

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
      `[webhooks/sent] Rejected: ${verification.reason}; headers_present=`,
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

  let body: Record<string, unknown>;
  try {
    body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    console.error("[webhooks/sent] Invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const eventType = normalizedEventType(body);
  const messageId = extractSentDmMessageIdForLookup(body);
  const contactId = extractSentDmContactId(body);

  if (messageId) {
    console.info(
      `[webhooks/sent] Legacy inbound envelope eventType=${eventType} message_id=${messageId}` +
        (contactId ? ` contactId=${contactId}` : "")
    );
  }

  return handleSentDmWebhookPost(body, verification, {
    route: "webhooks/sent",
    webhookEventSource: "sentdm",
    ingestSource: "sentdm_webhook",
    legacyRoute: true,
  });
}

export async function GET() {
  const secretConfigured = Boolean(process.env.SENTDM_WEBHOOK_SECRET?.trim());
  return NextResponse.json(
    {
      status: "ok",
      handler: "sentdm-webhook-legacy",
      canonical: "/api/sentdm/webhook",
      signature_required: secretConfigured,
      unsigned_dev_allowed:
        process.env.NODE_ENV === "development" &&
        process.env.SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS?.trim().toLowerCase() ===
          "true",
      integration_hint:
        "Legacy alias only; prefer POST /api/sentdm/webhook for new Sent.dm setups.",
    },
    { status: 200 }
  );
}
