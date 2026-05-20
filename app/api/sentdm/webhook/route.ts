import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifySentdmAuthenticity } from '@/lib/messaging/sentdm-webhook-auth';

/**
 * CloseOS — Sent.dm Webhook Receiver
 * POST /api/sentdm/webhook
 *
 * Receives delivery-status webhook events from Sent.dm,
 * logs them, stores the raw event in Supabase (webhook_events),
 * and updates messages.delivery_status using external_id.
 *
 * Tables used (existing schema):
 *   - webhook_events   — raw event log
 *   - messages          — canonical conversation messages updated first
 *   - lead_messages     — legacy fallback updated only when messages has no match
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

function getSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing Supabase env vars: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

// Map Sent.dm status values to our internal delivery_status values.
// Extend this map as Sent.dm documents additional statuses.
const STATUS_MAP: Record<string, string> = {
  delivered: 'delivered',
  sent: 'sent',
  failed: 'failed',
  bounced: 'bounced',
  opened: 'opened',
  clicked: 'clicked',
  unsubscribed: 'unsubscribed',
  complained: 'complained',
  rejected: 'rejected',
};

function normalizeStatus(raw: string | undefined): string {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase().trim();
  return STATUS_MAP[lower] ?? lower;
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

function firstString(
  source: Record<string, unknown>,
  paths: string[]
): string | null {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function normalizePhone(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;

  return trimmed;
}

function looksLikeInboundMessage(body: Record<string, unknown>) {
  const direction = firstString(body, [
    'direction',
    'message.direction',
    'data.direction',
    'payload.direction',
  ])?.toLowerCase();
  if (direction === 'inbound' || direction === 'incoming') return true;

  const eventType = firstString(body, ['event', 'type', 'event_type'])
    ?.toLowerCase()
    .replace(/[_\s]/g, '.');

  return [
    'message.inbound',
    'message.received',
    'sms.inbound',
    'sms.received',
    'reply.received',
    'reply.inbound',
  ].includes(eventType ?? '');
}

async function forwardInboundMessage(
  req: NextRequest,
  body: Record<string, unknown>,
  externalId: string
) {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return {
      ok: false,
      status: 500,
      result: { error: 'Missing INTERNAL_API_SECRET' },
    };
  }

  const phone = normalizePhone(
    firstString(body, [
      'from',
      'from_number',
      'fromNumber',
      'sender',
      'phone',
      'msisdn',
      'message.from',
      'message.phone',
      'from.phone',
      'from.number',
      'sender.phone',
      'sender.number',
      'contact.phone',
      'contact.msisdn',
      'data.from',
      'data.phone',
      'data.from.phone',
      'data.from.number',
      'payload.from',
      'payload.phone',
      'payload.from.phone',
      'payload.from.number',
    ])
  );
  const message = firstString(body, [
    'text',
    'body',
    'content',
    'message',
    'message.text',
    'message.body',
    'message.content',
    'data.text',
    'data.body',
    'data.message',
    'data.message.text',
    'data.message.body',
    'data.content',
    'payload.text',
    'payload.body',
    'payload.message',
    'payload.message.text',
    'payload.message.body',
    'payload.content',
  ]);
  const name = firstString(body, [
    'name',
    'sender_name',
    'contact.name',
    'message.name',
    'data.name',
    'payload.name',
  ]);

  if (!phone || !message) {
    return {
      ok: false,
      status: 400,
      result: {
        error: 'Inbound Sent.dm webhook missing phone or message text',
        phone_found: Boolean(phone),
        message_found: Boolean(message),
      },
    };
  }

  const inboundUrl = new URL('/api/inbound', req.url);
  const response = await fetch(inboundUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      phone,
      name,
      source: 'sms',
      message,
      provider: 'sentdm',
      external_id: externalId || null,
      raw_payload: body,
    }),
  });

  const result = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    result,
  };
}

export async function POST(req: NextRequest) {
  const receivedAt = new Date().toISOString();

  const rawBody = await req.text();

  const verification = verifySentdmAuthenticity(req.headers, rawBody);
  if (!verification.ok) {
    console.warn(`[sentdm/webhook] Rejected request: ${verification.reason}`);
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    console.error('[sentdm/webhook] Invalid JSON body');
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  // ── 2. Extract fields ─────────────────────────────────────────────
  const eventType = (body.event ?? body.type ?? 'unknown') as string;
  const externalId = (body.external_id ?? body.externalId ?? body.message_id ?? '') as string;
  const status = normalizeStatus((body.status ?? body.delivery_status) as string | undefined);
  const timestamp = (body.timestamp ?? receivedAt) as string;

  console.log(
    `[sentdm/webhook] event=${eventType} external_id=${externalId} status=${status} ts=${timestamp}`
  );

  // ── 3. Validate minimum payload ───────────────────────────────────
  if (!externalId) {
    console.warn('[sentdm/webhook] Missing external_id — storing event but cannot reconcile delivery status');
  }

  // ── 4. Store raw event ────────────────────────────────────────────
  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    console.error('[sentdm/webhook] Supabase init failed:', err);
    return NextResponse.json(
      { error: 'Server configuration error' },
      { status: 500 }
    );
  }

  const { error: insertError } = await supabase
    .from('webhook_events')
    .insert({
      source: 'sentdm',
      event_type: eventType,
      external_id: externalId || null,
      status,
      payload: body,
      received_at: receivedAt,
    });

  if (insertError) {
    console.error('[sentdm/webhook] Failed to insert webhook_events:', insertError.message);
    // Continue — we still want to try updating message status even if
    // the raw event log fails (e.g. table doesn't exist yet during dev).
  }

  if (looksLikeInboundMessage(body)) {
    const inboundResult = await forwardInboundMessage(req, body, externalId);

    if (!inboundResult.ok) {
      console.warn(
        `[sentdm/webhook] Inbound forward failed status=${inboundResult.status}`
      );
    }

    return NextResponse.json(
      {
        received: true,
        event_stored: !insertError,
        inbound_forwarded: inboundResult.ok,
        inbound_status: inboundResult.status,
        inbound_result: inboundResult.result,
      },
      { status: 200 }
    );
  }

  // ── 5. Update canonical messages delivery_status first ────────────
  if (externalId) {
    const { data: messageUpdateData, error: messageUpdateError } = await supabase
      .from('messages')
      .update({
        delivery_status: status,
        delivery_updated_at: receivedAt,
        status,
      })
      .eq('external_id', externalId)
      .select('id')
      .maybeSingle();

    if (messageUpdateError) {
      console.error('[sentdm/webhook] Failed to update messages:', messageUpdateError.message);
      return NextResponse.json(
        {
          received: true,
          event_stored: !insertError,
          message_updated: false,
          lead_updated: false,
          error: messageUpdateError.message,
        },
        { status: 200 }
      );
    }

    if (messageUpdateData) {
      console.log(
        `[sentdm/webhook] Updated messages id=${messageUpdateData.id} -> ${status}`
      );

      return NextResponse.json(
        {
          received: true,
          event_stored: !insertError,
          message_updated: true,
          lead_updated: false,
          status,
        },
        { status: 200 }
      );
    }

    const { data: legacyUpdateData, error: legacyUpdateError } = await supabase
      .from('lead_messages')
      .update({
        delivery_status: status,
        delivery_updated_at: receivedAt,
      })
      .eq('external_id', externalId)
      .select('id')
      .maybeSingle();

    if (legacyUpdateError) {
      console.error('[sentdm/webhook] Failed to update lead_messages:', legacyUpdateError.message);
      return NextResponse.json(
        {
          received: true,
          event_stored: !insertError,
          message_updated: false,
          lead_updated: false,
          error: legacyUpdateError.message,
        },
        { status: 200 } // 200 so the webhook provider doesn't retry on our DB issues
      );
    }

    if (!legacyUpdateData) {
      console.warn(
        `[sentdm/webhook] No messages or lead_messages row found for external_id=${externalId}`
      );
    } else {
      console.log(
        `[sentdm/webhook] Updated legacy lead_messages id=${legacyUpdateData.id} -> ${status}`
      );
    }

    return NextResponse.json(
      {
        received: true,
        event_stored: !insertError,
        message_updated: false,
        lead_updated: !!legacyUpdateData,
        status,
      },
      { status: 200 }
    );
  }

  // ── 6. No external_id — event stored only ─────────────────────────
  return NextResponse.json(
    {
      received: true,
      event_stored: !insertError,
      message_updated: false,
      lead_updated: false,
      status,
    },
    { status: 200 }
  );
}

// Sent.dm may send a GET to verify the endpoint is alive.
export async function GET() {
  return NextResponse.json(
    { status: 'ok', handler: 'sentdm-webhook' },
    { status: 200 }
  );
}