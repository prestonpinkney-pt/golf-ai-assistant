"use client";

export type MessageStatus =
  | "queued"
  | "processed"
  | "routed"
  | "sent"
  | "delivered"
  | "failed"
  | "provider_pending"
  | "unknown";

const STATUS_CONFIG: Record<
  MessageStatus,
  { label: string; className: string; dot: string }
> = {
  queued: {
    label: "Queued",
    className: "border-blue-200 bg-blue-50 text-blue-700",
    dot: "bg-blue-500",
  },
  processed: {
    label: "Processed",
    className: "border-blue-200 bg-blue-50 text-blue-700",
    dot: "bg-blue-500",
  },
  routed: {
    label: "Routed",
    className: "border-indigo-200 bg-indigo-50 text-indigo-700",
    dot: "bg-indigo-500",
  },
  sent: {
    label: "Sent",
    className: "border-indigo-200 bg-indigo-50 text-indigo-700",
    dot: "bg-indigo-500",
  },
  delivered: {
    label: "Delivered",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    dot: "bg-emerald-500",
  },
  failed: {
    label: "Failed",
    className: "border-red-200 bg-red-50 text-red-700",
    dot: "bg-red-500",
  },
  provider_pending: {
    label: "Provider Pending",
    className: "border-amber-200 bg-amber-50 text-amber-700",
    dot: "bg-amber-500",
  },
  unknown: {
    label: "Unknown",
    className: "border-slate-200 bg-slate-50 text-slate-600",
    dot: "bg-slate-400",
  },
};

function normalizeStatus(status: string | null | undefined): MessageStatus {
  if (!status) return "unknown";

  const normalized = status.toLowerCase().trim();

  if (normalized in STATUS_CONFIG) {
    return normalized as MessageStatus;
  }

  return "unknown";
}

export function MessageStatusBadge({
  status,
}: {
  status: MessageStatus | string | null | undefined;
}) {
  const key = normalizeStatus(status);
  const config = STATUS_CONFIG[key];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${config.className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot}`} />
      {config.label}
    </span>
  );
}