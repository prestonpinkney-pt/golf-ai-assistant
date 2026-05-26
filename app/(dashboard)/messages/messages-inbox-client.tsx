"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageStatusBadge } from "./message-status-badge";

const NO_STORE: RequestInit = {
  cache: "no-store",
  credentials: "include",
  headers: { "Cache-Control": "no-cache" },
};

function bust(path: string) {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}_=${Date.now()}`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

type ConversationListItem = {
  id: string;
  contactName: string;
  phoneMasked: string;
  preview: string;
  lastMessageAt: string | null;
  lastDirection: string | null;
  needsHuman: boolean;
  status: string | null;
};

type ThreadMessage = {
  id: string;
  direction: string;
  channel: string | null;
  body: string;
  status: string | null;
  deliveryStatus: string | null;
  aiGenerated: boolean;
  intent: string | null;
  riskLevel: string | null;
  escalationRequired: boolean;
  escalationReason: string | null;
  senderType: string | null;
  provider: string | null;
  createdAt: string | null;
  sentAt: string | null;
};

type ConversationDetail = {
  conversation: {
    id: string;
    status: string | null;
    needsHuman: boolean;
    escalationReason: string | null;
    automationEnabled: boolean;
  };
  contact: {
    id: string;
    name: string;
    phoneMasked: string;
    smsOptOut: boolean;
    coolingOffActive: boolean;
    sendBlockedReason: string | null;
  };
  messages: ThreadMessage[];
};

type DraftMeta = {
  intent?: string;
  confidence?: number;
  riskLevel?: string;
  escalationRequired?: boolean;
  escalationReason?: string | null;
};

export function MessagesInboxClient() {
  const [list, setList] = useState<ConversationListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [composer, setComposer] = useState("");
  const [draftMeta, setDraftMeta] = useState<DraftMeta | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [sendLoading, setSendLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);

  const loadList = useCallback(async (quiet = false) => {
    if (!quiet) {
      setListLoading(true);
      setListError(null);
    }
    try {
      const res = await fetch(bust("/api/conversations/recent"), NO_STORE);
      const json = (await res.json()) as {
        conversations?: ConversationListItem[];
        error?: string;
        details?: string;
      };
      if (!res.ok) {
        throw new Error(json.details || json.error || `HTTP ${res.status}`);
      }
      setList(json.conversations ?? []);
    } catch (e) {
      if (!quiet) {
        setListError(e instanceof Error ? e.message : "Failed to load conversations");
      }
    } finally {
      if (!quiet) setListLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (conversationId: string, quiet = false) => {
    if (!quiet) {
      setDetailLoading(true);
      setDetailError(null);
    }
    try {
      const res = await fetch(
        bust(`/api/conversations/${conversationId}`),
        NO_STORE
      );
      const json = (await res.json()) as ConversationDetail & {
        error?: string;
        details?: string;
      };
      if (!res.ok) {
        throw new Error(json.details || json.error || `HTTP ${res.status}`);
      }
      setDetail({
        conversation: json.conversation,
        contact: json.contact,
        messages: json.messages ?? [],
      });
    } catch (e) {
      if (!quiet) {
        setDetailError(e instanceof Error ? e.message : "Failed to load thread");
        setDetail(null);
      }
    } finally {
      if (!quiet) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setComposer("");
      setDraftMeta(null);
      setActionError(null);
      setSendSuccess(null);
      return;
    }
    setComposer("");
    setDraftMeta(null);
    setActionError(null);
    setSendSuccess(null);
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const sendBlocked = detail?.contact.sendBlockedReason ?? null;
  const needsHumanReview =
    detail?.conversation.needsHuman ||
    detail?.conversation.escalationReason ||
    draftMeta?.escalationRequired;

  async function handleGenerateDraft() {
    if (!selectedId || sendBlocked) return;
    setDraftLoading(true);
    setActionError(null);
    setSendSuccess(null);
    try {
      const res = await fetch("/api/ai/reply-draft", {
        ...NO_STORE,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: selectedId }),
      });
      const json = (await res.json()) as {
        draft_text?: string;
        error?: string;
        intent?: string;
        confidence?: number;
        risk_level?: string;
        escalation_required?: boolean;
        escalation_reason?: string | null;
      };
      if (!res.ok) {
        throw new Error(json.error || `Draft failed (${res.status})`);
      }
      setComposer(json.draft_text ?? "");
      setDraftMeta({
        intent: json.intent,
        confidence: json.confidence,
        riskLevel: json.risk_level,
        escalationRequired: json.escalation_required,
        escalationReason: json.escalation_reason,
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to generate draft");
    } finally {
      setDraftLoading(false);
    }
  }

  async function handleSend() {
    if (!selectedId || !composer.trim() || sendBlocked) return;
    setSendLoading(true);
    setActionError(null);
    setSendSuccess(null);
    try {
      const res = await fetch(`/api/conversations/${selectedId}/reply`, {
        ...NO_STORE,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: composer.trim() }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        throw new Error(json.error || `Send failed (${res.status})`);
      }
      setComposer("");
      setDraftMeta(null);
      setSendSuccess("Message sent. Delivery status will update when the provider confirms.");
      await Promise.all([loadDetail(selectedId, true), loadList(true)]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSendLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        AI drafts are suggestions. Nothing sends until you review and send.
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
              Conversations
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 md:text-3xl">
              Customer message command center
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Review inbound replies, inspect AI drafts, and send only after operator approval.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void loadList();
              if (selectedId) void loadDetail(selectedId);
            }}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Refresh
          </button>
        </div>
      </section>

      <div className="grid min-h-[560px] grid-cols-1 gap-4 lg:grid-cols-[minmax(280px,340px)_1fr]">
        <aside className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Inbox</h2>
            <p className="text-xs text-slate-500">
              {listLoading ? "Loading…" : `${list.length} conversation(s)`}
            </p>
          </div>

          {listError ? (
            <div className="p-4 text-sm text-red-700">{listError}</div>
          ) : null}

          {!listLoading && !listError && list.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-600">
              <p className="font-medium text-slate-800">No conversations yet</p>
              <p className="mt-2 leading-6">
                Inbound SMS will appear here after Sent.dm webhooks are processed.
              </p>
            </div>
          ) : null}

          <ul className="max-h-[520px] divide-y divide-slate-100 overflow-y-auto">
            {list.map((item) => {
              const active = item.id === selectedId;
              const inboundWaiting =
                (item.lastDirection ?? "").toLowerCase() === "inbound";
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={`w-full px-4 py-3 text-left transition ${
                      active ? "bg-emerald-50/80" : "hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">
                          {item.contactName}
                        </p>
                        <p className="text-xs text-slate-500">{item.phoneMasked}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {item.needsHuman ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                            Needs human
                          </span>
                        ) : null}
                        {inboundWaiting ? (
                          <span
                            className="inline-block h-2 w-2 rounded-full bg-emerald-500"
                            title="Latest message inbound"
                          />
                        ) : null}
                      </div>
                    </div>
                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-600">
                      {item.preview}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {formatTime(item.lastMessageAt)}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="flex min-h-[560px] flex-col rounded-3xl border border-slate-200 bg-white shadow-sm">
          {!selectedId ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-sm text-slate-600">
              <p className="font-medium text-slate-800">Select a conversation</p>
              <p className="mt-2 max-w-sm leading-6">
                Choose a thread from the inbox to review messages and send a reply.
              </p>
            </div>
          ) : detailLoading && !detail ? (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
              Loading thread…
            </div>
          ) : detailError ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-red-700">
              {detailError}
            </div>
          ) : detail ? (
            <>
              <header className="border-b border-slate-100 px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-950">
                      {detail.contact.name}
                    </h2>
                    <p className="text-sm text-slate-500">{detail.contact.phoneMasked}</p>
                    {detail.conversation.status ? (
                      <p className="mt-1 text-xs text-slate-400">
                        Status: {detail.conversation.status.replace(/_/g, " ")}
                      </p>
                    ) : null}
                  </div>
                  {detail.conversation.needsHuman ? (
                    <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
                      Needs human review
                    </span>
                  ) : null}
                </div>
                {detail.conversation.escalationReason ? (
                  <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                    Escalation: {detail.conversation.escalationReason}
                  </p>
                ) : null}
              </header>

              <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
                {detail.messages.length === 0 ? (
                  <p className="text-center text-sm text-slate-500">
                    No messages in this thread yet.
                  </p>
                ) : (
                  detail.messages.map((msg) => {
                    const outbound = msg.direction === "outbound";
                    return (
                      <div
                        key={msg.id}
                        className={`flex ${outbound ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                            outbound
                              ? "bg-emerald-600 text-white"
                              : "bg-slate-100 text-slate-800"
                          }`}
                        >
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">
                              {outbound ? "Outbound" : "Inbound"}
                            </span>
                            {msg.aiGenerated ? (
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                  outbound
                                    ? "bg-emerald-500/40 text-white"
                                    : "bg-white text-slate-600"
                                }`}
                              >
                                AI
                              </span>
                            ) : null}
                            {msg.escalationRequired ? (
                              <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-900">
                                Escalated
                              </span>
                            ) : null}
                            {msg.riskLevel ? (
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                  outbound
                                    ? "bg-emerald-500/40 text-white"
                                    : "bg-slate-200 text-slate-700"
                                }`}
                              >
                                Risk: {msg.riskLevel}
                              </span>
                            ) : null}
                          </div>
                          <p className="whitespace-pre-wrap text-sm leading-6">{msg.body}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {outbound && msg.deliveryStatus ? (
                              <MessageStatusBadge status={msg.deliveryStatus} />
                            ) : null}
                            {msg.intent ? (
                              <span className="text-[10px] opacity-70">Intent: {msg.intent}</span>
                            ) : null}
                            <span className="text-[10px] opacity-60">
                              {formatTime(msg.sentAt ?? msg.createdAt)}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <footer className="border-t border-slate-100 px-5 py-4">
                {sendBlocked ? (
                  <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                    Send blocked: {sendBlocked}
                  </div>
                ) : null}

                {needsHumanReview && !sendBlocked ? (
                  <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    This conversation may need human review before you send.
                  </div>
                ) : null}

                {actionError ? (
                  <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                    {actionError}
                  </div>
                ) : null}

                {sendSuccess ? (
                  <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    {sendSuccess}
                  </div>
                ) : null}

                {draftMeta ? (
                  <p className="mb-2 text-xs text-slate-500">
                    AI draft
                    {draftMeta.intent ? ` · ${draftMeta.intent}` : ""}
                    {typeof draftMeta.confidence === "number"
                      ? ` · ${Math.round(draftMeta.confidence * 100)}% confidence`
                      : ""}
                    {draftMeta.riskLevel ? ` · ${draftMeta.riskLevel} risk` : ""}
                  </p>
                ) : null}

                <textarea
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  disabled={Boolean(sendBlocked) || sendLoading}
                  placeholder={
                    sendBlocked
                      ? "Sending is blocked for this contact."
                      : "Write your reply or generate an AI draft…"
                  }
                  rows={4}
                  className="w-full resize-y rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                />

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleGenerateDraft()}
                    disabled={Boolean(sendBlocked) || draftLoading || sendLoading}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {draftLoading ? "Generating…" : "Generate AI draft"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={
                      Boolean(sendBlocked) ||
                      sendLoading ||
                      draftLoading ||
                      !composer.trim()
                    }
                    className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {sendLoading ? "Sending…" : "Send reply"}
                  </button>
                </div>
              </footer>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
