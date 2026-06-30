import { NextRequest, NextResponse } from "next/server";
import {
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
      `[CloseOS sent webhook] Rejected request: ${verification.reason}; headers=`,
      headerDiag
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: Record<string, unknown>;

  try {
    payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json(
      { ok: false, ignored: true, reason: "invalid_json" },
      { status: 400 }
    );
  }

  console.info(
    `[CloseOS sent webhook] Forwarding legacy route eventType=${normalizedEventType(
      payload
    )} through canonical Sent.dm pipeline.`
  );

  return handleSentDmWebhookPost(payload, verification, {
    route: "webhooks/sent",
    webhookEventSource: "sentdm",
    ingestSource: "sentdm_webhook",
    legacyRoute: true,
  });
}
