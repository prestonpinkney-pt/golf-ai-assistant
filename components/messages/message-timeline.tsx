"use client";

import { MessageStatusBadge } from "./message-status-badge";

export type TimelineMessage = {
  id: string;
  lead_id: string;
  direction: "inbound" | "outbound";
  channel: "sms" | "email" | string;
  body: string;
  delivery_status: string | null;
  provider?: string | null;
  external_id?: string | null;
  sent_at?: string | null;
  delivery_updated_at?: string | null;
};

function formatDate(value: string | null | undefined) {
  if (!value) return "—";

  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function MessageTimeline({
  messages,
}: {
  messages: TimelineMessage[];
}) {
  if (!messages.length) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
        <div className="text-sm font-semibold text-slate-900">
          No message attempts yet
        </div>
        <p className="mt-2 text-sm text-slate-500">
          Once leads trigger outbound messages, they’ll appear here.
        </p>
      </div>
    );
  }

  const sortedMessages = [...messages].sort((a, b) => {
    const aTime = a.sent_at ? new Date(a.sent_at).getTime() : 0;
    const bTime = b.sent_at ? new Date(b.sent_at).getTime() : 0;
    return bTime - aTime;
  });

  return (
    <div className="space-y-3">
      {sortedMessages.map((message) => {
        const isSentdm = message.provider?.toLowerCase() === "sentdm";
        const isFailed = message.delivery_status?.toLowerCase() === "failed";
        const missingExternalId = isSentdm && !message.external_id;

        return (
          <article
            key={message.id}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                {message.direction}
              </span>

              <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {message.channel}
              </span>

              {message.provider && (
                <span className="text-xs font-medium text-slate-400">
                  via {message.provider}
                </span>
              )}

              <div className="ml-auto flex items-center gap-3">
                <MessageStatusBadge
                  status={
                    missingExternalId
                      ? "provider_pending"
                      : message.delivery_status
                  }
                />

                <span className="text-xs text-slate-400">
                  {formatDate(message.sent_at)}
                </span>
              </div>
            </div>

            <p className="mt-4 text-sm leading-6 text-slate-700">
              {message.body}
            </p>

            {message.external_id && (
              <div className="mt-3 text-xs text-slate-400">
                External ID: {message.external_id}
                {message.delivery_updated_at && (
                  <span> · Updated {formatDate(message.delivery_updated_at)}</span>
                )}
              </div>
            )}

            {missingExternalId && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
                Provider message ID missing — status updates cannot attach yet.
              </div>
            )}

            {isFailed && isSentdm && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-800">
                Sent.dm approval or carrier delivery may still be blocking
                delivery.
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}