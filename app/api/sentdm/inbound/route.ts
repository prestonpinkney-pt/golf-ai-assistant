import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  extractSentDmMessageExternalId,
  verifySentDmAuthenticity,
  sentDmWebhookSignatureHeaderPresence,
  looksLikeInboundMessage,
} from "@/lib/messaging/sentdm-webhook";
import { processSentDmWebhookJobFromPending } from "@/lib/sentdm/process-webhook-job";
import { enqueueSentDmInboundWebhookJob } from "@/lib/sentdm/webhook-queue";
import { logMessagingAudit } from "@/lib/messaging/audit";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function getSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

function scheduleInboundJob(jobId: string) {
  after(async () => {
    try {
      const sb = getSupabase();
      await processSentDmWebhookJobFromPending(sb, jobId);
    } catch (err) {
      console.error("[sentdm/inbound] deferred webhook_jobs processing:", err);
    }
  });
}

/**
 * CloseOS — Sent.dm dedicated inbound ingress (queues fast; processing async).
 * POST /api/sentdm/inbound
 */
export async function POST(req: NextRequest) {
  const receivedAt = new Date().toISOString();
  const rawBody = await req.text();
  const headerDiag = sentDmWebhookSignatureHeaderPresence(req);

  const verification = verifySentDmAuthenticity(req, rawBody);
  if (!verification.ok) {
    console.warn(
      `[sentdm/inbound] Rejected: ${verification.reason}; headers=`,
      headerDiag
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[sentdm/inbound] verified=", verification.mode, "headers=", headerDiag);

  let body: Record<string, unknown>;
  try {
    body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch (e) {
    console.error("[sentdm/inbound]", e);
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 }
    );
  }

  const eventType = String(
    body.sub_type ?? body.subtype ?? body.event ?? body.type ?? "sentdm_inbound_post"
  );
  const externalId = extractSentDmMessageExternalId(body) ?? "";

  const { error: weErr } = await supabase.from("webhook_events").insert({
    source: "sentdm",
    event_type: eventType,
    external_id: externalId || null,
    status: "inbound_enqueue",
    payload: body,
    received_at: receivedAt,
  });

  if (weErr) {
    console.warn("[sentdm/inbound] webhook_events insert:", weErr.message);
  }

  await logMessagingAudit(supabase, {
    event_type: "webhook_received",
    entity_type: "messaging",
    entity_id: externalId || null,
    metadata: {
      provider: "sentdm",
      route: "/api/sentdm/inbound",
      signature_mode: verification.mode,
      webhook_events_saved: !weErr,
    },
  });

  if (!looksLikeInboundMessage(body)) {
    return NextResponse.json(
      { received: true, queued: false, skipped: true, reason: "non_inbound_shape" },
      { status: 200 }
    );
  }

  const enqueued = await enqueueSentDmInboundWebhookJob(supabase, {
    payload: body,
    eventType,
    ingestSource: "sentdm_inbound_route",
  });

  if (!enqueued.ok) {
    console.error("[sentdm/inbound] webhook_jobs enqueue failed:", enqueued.error);
    return NextResponse.json(
      { received: false, error: enqueued.error },
      { status: 503 }
    );
  }

  if (enqueued.duplicate) {
    if (enqueued.requeued) {
      await logMessagingAudit(supabase, {
        event_type: "webhook_duplicate_requeued",
        entity_type: "webhook_job",
        entity_id: enqueued.jobId,
        metadata: { route: "/api/sentdm/inbound", external_id: externalId || null },
      });
      scheduleInboundJob(enqueued.jobId);
      return NextResponse.json(
        {
          received: true,
          queued: true,
          duplicate: true,
          requeued: true,
          job_id: enqueued.jobId,
        },
        { status: 200 }
      );
    }

    await logMessagingAudit(supabase, {
      event_type: "webhook_duplicate_ignored",
      entity_type: "webhook_job",
      entity_id: enqueued.jobId,
      metadata: {
        route: "/api/sentdm/inbound",
        external_id: externalId || null,
        existing_status: enqueued.status,
      },
    });
    return NextResponse.json(
      {
        received: true,
        queued: false,
        duplicate: true,
        job_id: enqueued.jobId,
        existing_status: enqueued.status,
      },
      { status: 200 }
    );
  }

  await logMessagingAudit(supabase, {
    event_type: "webhook_job_created",
    entity_type: "webhook_job",
    entity_id: enqueued.jobId,
    metadata: { route: "/api/sentdm/inbound" },
  });

  scheduleInboundJob(enqueued.jobId);

  return NextResponse.json(
    {
      received: true,
      queued: true,
      job_id: enqueued.jobId,
    },
    { status: 200 }
  );
}

export async function GET() {
  return NextResponse.json(
    { status: "ok", handler: "sentdm-inbound" },
    { status: 200 }
  );
}
