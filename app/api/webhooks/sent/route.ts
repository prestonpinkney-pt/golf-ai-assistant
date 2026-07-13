import { type NextRequest, NextResponse } from "next/server";

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

/**
 * Legacy Sent.dm webhook alias.
 *
 * Keep this route behaviorally identical to /api/sentdm/webhook because older
 * Sent.dm dashboard configurations and operator docs still reference it.
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
    return NextResponse.json(
      {
        ok: false,
        error: "Invalid JSON body",
        legacy_route: true,
        canonical_route: "/api/sentdm/webhook",
      },
      { status: 400 }
    );
  }

  console.info(
    `[webhooks/sent] Delegating legacy event=${normalizedEventType(body)} to canonical Sent.dm queue`
  );

  return handleSentDmWebhookPost(body, verification, {
    route: "webhooks/sent",
    webhookEventSource: "sentdm",
    ingestSource: "sentdm_webhook",
    legacyRoute: true,
  });
}

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      handler: "sentdm-webhook-legacy",
      canonical_route: "/api/sentdm/webhook",
    },
    { status: 200 }
  );
}
