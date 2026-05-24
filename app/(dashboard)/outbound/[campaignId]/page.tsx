"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CAMPAIGNS_SETUP_MESSAGE } from "@/app/api/campaigns/setup-copy";
import {
  campaignBatchExecutionLabel,
  campaignMessageExecutionLabel,
} from "@/lib/operator-ui-copy";

type Campaign = {
  id: string;
  name: string;
  status: string;
  playbook_key: string | null;
  total_recipients: number;
  total_drafted: number;
  total_approved: number;
  total_sent: number;
  total_failed: number;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  sent_at: string | null;
};

type CampaignMessage = {
  id: string;
  contact_name: string | null;
  phone: string | null;
  message_text: string;
  status: string;
  delivery_status: string | null;
  external_id: string | null;
  error_message: string | null;
  approved_at: string | null;
  sent_at: string | null;
  failed_at: string | null;
  opportunity_id: string | null;
};

function statusBadgeClass(status: string) {
  switch (status) {
    case "sent":
      return "bg-emerald-100 text-emerald-900";
    case "approved":
      return "bg-sky-100 text-sky-900";
    case "sending":
      return "bg-amber-100 text-amber-900";
    case "failed":
      return "bg-red-100 text-red-800";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

function rollupStatusLabel(status: string) {
  return campaignBatchExecutionLabel(status);
}

const NO_STORE: RequestInit = {
  cache: "no-store",
  headers: { "Cache-Control": "no-cache" },
};

export default function CampaignDetailPage() {
  const params = useParams();
  const campaignId = typeof params.campaignId === "string" ? params.campaignId : "";

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [messages, setMessages] = useState<CampaignMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [checkedApprove, setCheckedApprove] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    setError(null);
    setSetupMessage(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}?_${Date.now()}`, {
        ...NO_STORE,
        credentials: "include",
      });
      const json = (await res.json()) as {
        campaign?: Campaign;
        messages?: CampaignMessage[];
        error?: string;
        setupMessage?: string;
      };
      if (!res.ok) {
        if (res.status === 503 && json.setupMessage) {
          setSetupMessage(json.setupMessage ?? CAMPAIGNS_SETUP_MESSAGE);
          setCampaign(json.campaign ?? null);
          setMessages([]);
          setDraftEdits({});
          return;
        }
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setCampaign(json.campaign ?? null);
      const list = json.messages ?? [];
      setMessages(list);
      const edits: Record<string, string> = {};
      for (const m of list) {
        edits[m.id] = m.message_text ?? "";
      }
      setDraftEdits(edits);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaign");
      setCampaign(null);
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveDraft = async (messageId: string) => {
    const text = (draftEdits[messageId] ?? "").trim();
    if (!text) {
      setActionError("Message cannot be empty.");
      return;
    }
    setBusy(`save-${messageId}`);
    setActionError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/messages/${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message_text: text }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  };

  const approveSelected = async () => {
    const ids = Object.entries(checkedApprove)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (ids.length === 0) {
      setActionError("Select agent drafts to approve.");
      return;
    }
    setBusy("approve");
    setActionError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messageIds: ids }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setCheckedApprove({});
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusy(null);
    }
  };

  const sendApproved = async () => {
    setBusy("send");
    setActionError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(null);
    }
  };

  const revertToDraft = async (messageId: string) => {
    setBusy(`rev-${messageId}`);
    setActionError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/messages/${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status: "draft" }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const approvedCount = messages.filter((m) => m.status === "approved").length;

  if (!campaignId) {
    return (
      <main className="p-6 text-slate-600">
        <p>Invalid campaign.</p>
        <Link href="/campaigns" className="text-emerald-800 underline">
          Back to campaigns
        </Link>
      </main>
    );
  }

  return (
    <main className="text-slate-900">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link
          href="/campaigns"
          className="text-sm font-semibold text-emerald-800 underline-offset-2 hover:underline"
        >
          ← Campaigns
        </Link>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading campaign…</p>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : setupMessage ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            {setupMessage}
          </div>
          {campaign ? (
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-800">
                This campaign
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 md:text-3xl">
                {campaign.name}
              </h1>
              <p className="mt-3 text-sm text-slate-600">
                Recipient list is unavailable until campaign storage is fully set up in
                Supabase.
              </p>
            </section>
          ) : (
            <p className="text-slate-600">Campaign not found.</p>
          )}
        </div>
      ) : !campaign ? (
        <p className="text-slate-600">Campaign not found.</p>
      ) : (
        <>
          <section className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-white via-emerald-50/30 to-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-800">
              Agent batch
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 md:text-3xl">
              {campaign.name}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              CloseOS drafted these SMS. Review each message, approve what you’re happy
              with, then send — nothing leaves without your go-ahead.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span
                className={`rounded-md px-2 py-1 text-[11px] font-bold uppercase ${statusBadgeClass(campaign.status)}`}
              >
                {rollupStatusLabel(campaign.status)}
              </span>
              {campaign.playbook_key ? (
                <span className="rounded-md bg-white px-2 py-1 text-[11px] font-semibold uppercase text-slate-600 ring-1 ring-slate-200">
                  {campaign.playbook_key}
                </span>
              ) : null}
            </div>
            <p className="mt-3 text-sm text-slate-600">
              {campaign.total_recipients} people · {campaign.total_drafted} draft
              {campaign.total_drafted === 1 ? "" : "s"} · {campaign.total_approved} ready to
              send · {campaign.total_sent} sent
              {campaign.total_failed ? ` · ${campaign.total_failed} did not go through` : ""}
            </p>
          </section>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void approveSelected()}
              className="rounded-lg border border-emerald-600 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
            >
              {busy === "approve" ? "Approving…" : "Approve to send (selected)"}
            </button>
            <button
              type="button"
              disabled={busy !== null || approvedCount === 0}
              onClick={() => void sendApproved()}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "send" ? "Sending…" : `Send approved messages (${approvedCount})`}
            </button>
          </div>
          {actionError ? (
            <p className="mt-2 text-sm text-red-700">{actionError}</p>
          ) : null}

          <section className="mt-8 space-y-4">
            <h2 className="text-lg font-semibold text-slate-900">People to contact</h2>
            {messages.map((m) => {
              const isDraft = m.status === "draft";
              const isApproved = m.status === "approved";
              return (
                <article
                  key={m.id}
                  className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-900">
                        {m.contact_name ?? "—"}
                      </p>
                      <p className="font-mono text-xs text-slate-600">{m.phone ?? "—"}</p>
                      {m.opportunity_id ? (
                        <p className="mt-1 text-[11px] text-slate-500">
                          From a revenue follow-up
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-md px-2 py-1 text-[11px] font-bold uppercase ${statusBadgeClass(m.status)}`}
                      >
                        {campaignMessageExecutionLabel(m.status, m.delivery_status)}
                      </span>
                    </div>
                  </div>

                  {isDraft ? (
                    <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Agent draft
                    </label>
                  ) : null}

                  {isDraft ? (
                    <>
                      <textarea
                        value={draftEdits[m.id] ?? ""}
                        onChange={(e) =>
                          setDraftEdits((d) => ({ ...d, [m.id]: e.target.value }))
                        }
                        rows={4}
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                      />
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void saveDraft(m.id)}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {busy === `save-${m.id}` ? "Saving…" : "Save agent draft"}
                        </button>
                        <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                          <input
                            type="checkbox"
                            checked={Boolean(checkedApprove[m.id])}
                            onChange={(e) =>
                              setCheckedApprove((c) => ({
                                ...c,
                                [m.id]: e.target.checked,
                              }))
                            }
                          />
                          Queue for approval
                        </label>
                      </div>
                    </>
                  ) : (
                    <p className="mt-3 whitespace-pre-wrap text-sm text-slate-800">
                      {m.message_text}
                    </p>
                  )}

                  {!isDraft && isApproved ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void revertToDraft(m.id)}
                      className="mt-2 text-xs font-semibold text-slate-600 underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      Return to draft
                    </button>
                  ) : null}

                  {m.error_message ? (
                    <p className="mt-2 text-xs text-red-700">{m.error_message}</p>
                  ) : null}
                </article>
              );
            })}
          </section>
        </>
      )}
    </main>
  );
}
