'use client';

/**
 * CloseOS — MessageStatusBadge
 *
 * Renders a compact, color-coded pill for message delivery status.
 * Normalizes any raw status string to a known visual treatment.
 *
 * Colors:
 *   delivered       → green
 *   failed          → red
 *   provider_pending→ amber
 *   sent/routed/processed/queued → blue/indigo
 *   unknown         → gray
 */

export type MessageStatus =
  | 'queued'
  | 'processed'
  | 'routed'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'provider_pending'
  | 'unknown';

const STATUS_CONFIG: Record<
  MessageStatus,
  { label: string; bg: string; text: string; dot: string }
> = {
  queued: {
    label: 'Queued',
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    dot: 'bg-blue-400',
  },
  processed: {
    label: 'Processed',
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    dot: 'bg-blue-400',
  },
  routed: {
    label: 'Routed',
    bg: 'bg-indigo-50',
    text: 'text-indigo-700',
    dot: 'bg-indigo-400',
  },
  sent: {
    label: 'Sent',
    bg: 'bg-indigo-50',
    text: 'text-indigo-700',
    dot: 'bg-indigo-500',
  },
  delivered: {
    label: 'Delivered',
    bg: 'bg-emerald-50',
    text: 'text-emerald-700',
    dot: 'bg-emerald-500',
  },
  failed: {
    label: 'Failed',
    bg: 'bg-red-50',
    text: 'text-red-700',
    dot: 'bg-red-500',
  },
  provider_pending: {
    label: 'Provider Pending',
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    dot: 'bg-amber-500',
  },
  unknown: {
    label: 'Unknown',
    bg: 'bg-slate-100',
    text: 'text-slate-500',
    dot: 'bg-slate-400',
  },
};

function normalize(raw: string | null | undefined): MessageStatus {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase().trim();
  if (lower in STATUS_CONFIG) return lower as MessageStatus;
  return 'unknown';
}

interface MessageStatusBadgeProps {
  status: MessageStatus | string | null | undefined;
}

export function MessageStatusBadge({ status }: MessageStatusBadgeProps) {
  const key = normalize(status);
  const config = STATUS_CONFIG[key];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${config.bg} ${config.text}`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${config.dot}`}
      />
      {config.label}
    </span>
  );
}
