'use client';

import { MessageStatusBadge } from "./message-status-badge";

/**
 * CloseOS — MessageTimeline
 *
 * Displays a chronological list of message attempts for operator review.
 * Surfaces delivery status, provider info, and actionable context when
 * things are pending or failed — especially during Sent.dm pre-approval.
 */

export interface TimelineMessage {
  id: string;
  lead_id: string;
  direction: 'inbound' | 'outbound';
  channel: 'sms' | 'email' | string;
  body: string;
  delivery_status: string | null;
  provider?: string | null;
  external_id?: string | null;
  sent_at?: string | null;
  delivery_updated_at?: string | null;
}

interface MessageTimelineProps {
  messages: TimelineMessage[];
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function DirectionIndicator({ direction }: { direction: string }) {
  const isOutbound = direction === 'outbound';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
        isOutbound
          ? 'bg-indigo-50 text-indigo-600'
          : 'bg-slate-100 text-slate-500'
      }`}
    >
      {isOutbound ? '↑ Out' : '↓ In'}
    </span>
  );
}

function ChannelLabel({ channel }: { channel: string }) {
  return (
    <span className="rounded-md bg-slate-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
      {channel}
    </span>
  );
}

export function MessageTimeline({ messages }: MessageTimelineProps) {
  if (!messages || messages.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-100 bg-white/80 px-8 py-16 text-center backdrop-blur-sm">
        <div className="mx-auto max-w-sm">
          <div className="text-3xl">💬</div>
          <p className="mt-3 text-sm leading-relaxed text-slate-500">
            No message attempts yet. Once leads trigger outbound messages,
            they&apos;ll appear here.
          </p>
        </div>
      </div>
    );
  }

  // Newest first
  const sorted = [...messages].sort((a, b) => {
    const tA = a.sent_at ? new Date(a.sent_at).getTime() : 0;
    const tB = b.sent_at ? new Date(b.sent_at).getTime() : 0;
    return tB - tA;
  });

  return (
    <div className="space-y-3">
      {sorted.map((msg) => {
        const isSentdm = msg.provider?.toLowerCase() === 'sentdm';
        const missingExternalId = !msg.external_id;
        const isFailed =
          msg.delivery_status?.toLowerCase() === 'failed';

        const showMissingIdWarning = isSentdm && missingExternalId;
        const showFailedWarning = isFailed && isSentdm;

        return (
          <div
            key={msg.id}
            className="group rounded-2xl border border-slate-100 bg-white/80 p-5 shadow-sm backdrop-blur-sm transition-shadow hover:shadow-md"
          >
            {/* Row 1: meta line */}
            <div className="flex flex-wrap items-center gap-2">
              <DirectionIndicator direction={msg.direction} />
              <ChannelLabel channel={msg.channel} />

              {msg.provider && (
                <span className="text-[11px] text-slate-400">
                  via {msg.provider}
                </span>
              )}

              <div className="ml-auto flex items-center gap-3">
                <MessageStatusBadge status={msg.delivery_status} />
                <span className="text-xs tabular-nums text-slate-400">
                  {formatTimestamp(msg.sent_at)}
                </span>
              </div>
            </div>

            {/* Row 2: body */}
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              {msg.body}
            </p>

            {/* Row 3: external_id reference */}
            {msg.external_id && (
              <div className="mt-2 text-[11px] text-slate-400">
                ext: {msg.external_id}
                {msg.delivery_updated_at && (
                  <span className="ml-2">
                    · updated {formatTimestamp(msg.delivery_updated_at)}
                  </span>
                )}
              </div>
            )}

            {/* Warning: missing external_id on sentdm provider */}
            {showMissingIdWarning && (
              <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50/80 px-4 py-2.5 text-xs leading-relaxed text-amber-800">
                Provider message ID missing — status updates cannot attach
                yet.
              </div>
            )}

            {/* Warning: failed + sentdm */}
            {showFailedWarning && (
              <div className="mt-3 rounded-lg border border-red-100 bg-red-50/80 px-4 py-2.5 text-xs leading-relaxed text-red-800">
                Sent.dm approval or carrier delivery may still be blocking
                delivery.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
