import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * CloseOS — Sent.dm Webhook Receiver
 * POST /api/sentdm/webhook
 *
 * Receives delivery-status webhook events from Sent.dm,
 * logs them, stores the raw event in Supabase (webhook_events),
 * and updates lead_messages.delivery_status using external_id.
 *
 * Tables used (existing schema):
 *   - webhook_events   — raw event log
 *   - lead_messages     — delivery_status updated via external_id match
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

export async function POST(req: NextRequest) {
  const receivedAt = new Date().toISOString();

  // ── 1. Parse body ──────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
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
    console.warn('[sentdm/webhook] Missing external_id — storing event but cannot update lead_messages');
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
    // Continue — we still want to try updating lead_messages even if
    // the raw event log fails (e.g. table doesn't exist yet during dev).
  }

  // ── 5. Update lead_messages delivery_status ───────────────────────
  if (externalId) {
    const { data: updateData, error: updateError } = await supabase
      .from('lead_messages')
      .update({
        delivery_status: status,
        delivery_updated_at: receivedAt,
      })
      .eq('external_id', externalId)
      .select('id')
      .maybeSingle();

    if (updateError) {
      console.error('[sentdm/webhook] Failed to update lead_messages:', updateError.message);
      return NextResponse.json(
        {
          received: true,
          event_stored: !insertError,
          lead_updated: false,
          error: updateError.message,
        },
        { status: 200 } // 200 so the webhook provider doesn't retry on our DB issues
      );
    }

    if (!updateData) {
      console.warn(
        `[sentdm/webhook] No lead_messages row found for external_id=${externalId}`
      );
    } else {
      console.log(
        `[sentdm/webhook] Updated lead_messages id=${updateData.id} → ${status}`
      );
    }

    return NextResponse.json(
      {
        received: true,
        event_stored: !insertError,
        lead_updated: !!updateData,
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