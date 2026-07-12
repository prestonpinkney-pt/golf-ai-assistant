import { NextRequest, NextResponse } from "next/server";

import {
  sentDmWebhookSignatureHeaderPresence,
  verifySentDmAuthenticity,
} from "@/lib/messaging/sentdm-webhook";
import { handleSentDmWebhookPost } from "@/lib/sentdm/handle-webhook-post";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const headerDiag = sentDmWebhookSignatureHeaderPresence(req);
  const verification = verifySentDmAuthenticity(req, rawBody);
  if (!verification.ok) {
    console.warn(
      `[CloseOS sent webhook] Rejected request: ${verification.reason}; headers_present=`,
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

  return handleSentDmWebhookPost(payload, verification, {
    route: "webhooks/sent",
    webhookEventSource: "sent",
    ingestSource: "sentdm_webhook",
    legacyRoute: true,
  });
}
