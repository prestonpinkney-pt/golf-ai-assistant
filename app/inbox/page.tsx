"use client";

import React, { useEffect, useState } from "react";

type Lead = {
  id: string;
  name?: string;
  phone?: string;
  email?: string;
  preferredChannel?: string;
  message: string;
  reply: string;
  intents: string[];
  primaryIntent: string;
  secondaryIntents: string[];
  complexity: string;
  leadTemperature: string;
  persona: string;
  pressureMode: string;
  goal: string;
  shouldEscalate: boolean;
  status: string;
  statusReason?: string;
  followUpCount: number;
  followUpMessage?: string;
  nextFollowUpAt: string | null;
  lastFollowUpAt: string | null;
  lastContactedAt?: string | null;
  lastSendChannel?: string;
  lastSendResult?: string;
  createdAt: string;
};

function formatDate(value?: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

function statusChipClass(status: string) {
  switch (status) {
    case "booked":
      return "bg-emerald-50 text-emerald-700 ring-emerald-600/20";
    case "closed":
      return "bg-slate-100 text-slate-700 ring-slate-300";
    case "contacted":
      return "bg-blue-50 text-blue-700 ring-blue-600/20";
    default:
      return "bg-amber-50 text-amber-700 ring-amber-600/20";
  }
}

export default function InboxPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [runStatus, setRunStatus] = useState("");

  async function loadLeads() {
    try {
      setLoading(true);
      setError("");

      const res = await fetch("/api/leads");
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to load leads");
        setLoading(false);
        return;
      }

      setLeads(data);
    } catch (err: any) {
      setError(err?.message || "Something went wrong");
    }

    setLoading(false);
  }

  async function updateStatus(id: string, status: string) {
    try {
      const res = await fetch("/api/leads/update-status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id, status }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Failed to update status");
        return;
      }

      loadLeads();
    } catch (err: any) {
      alert(err?.message || "Something went wrong");
    }
  }

  async function runFollowUp(id: string) {
    try {
      const res = await fetch("/api/leads/follow-up", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Failed to trigger follow-up");
        return;
      }

      loadLeads();
    } catch (err: any) {
      alert(err?.message || "Something went wrong");
    }
  }

  async function runAIStatus(id: string) {
    try {
      const res = await fetch("/api/leads/ai-status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Failed to auto-set status");
        return;
      }

      loadLeads();
    } catch (err: any) {
      alert(err?.message || "Something went wrong");
    }
  }

  async function scheduleFollowUp(id: string, channel: "sms" | "email") {
    try {
      const res = await fetch("/api/leads/schedule-follow-up", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id,
          channel,
          hoursFromNow: 24,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Failed to schedule follow-up");
        return;
      }

      loadLeads();
    } catch (err: any) {
      alert(err?.message || "Something went wrong");
    }
  }

  async function runDueFollowUps() {
    try {
      setRunStatus("Running due follow-ups...");

      const res = await fetch("/api/leads/run-due-follow-ups", {
        method: "POST",
      });

      const data = await res.json();

      if (!res.ok) {
        setRunStatus(data.error || "Failed to run due follow-ups");
        return;
      }

      setRunStatus(`Processed ${data.processedCount} due follow-up(s)`);
      loadLeads();
    } catch (err: any) {
      setRunStatus(err?.message || "Something went wrong");
    }
  }

  useEffect(() => {
    loadLeads();
  }, []);

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8 text-slate-900">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col justify-between gap-5 border-b border-slate-200 pb-6 md:flex-row md:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              CloseOS
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-black">
              Leads Inbox
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              Review lead context, update lifecycle status, and trigger follow-up actions.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              onClick={loadLeads}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Refresh
            </button>
            <button
              onClick={runDueFollowUps}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Run Due Follow-Ups
            </button>
          </div>
        </div>

        {runStatus && (
          <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            <span className="font-semibold">Follow-Up Runner:</span> {runStatus}
          </div>
        )}

        {loading && <p className="mt-6 text-sm text-slate-600">Loading leads...</p>}

        {error && (
          <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span className="font-semibold">Error:</span> {error}
          </div>
        )}

        {!loading && !error && leads.length === 0 && (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
            <p className="text-sm text-slate-600">No leads yet.</p>
          </div>
        )}

        {!loading && !error && leads.length > 0 && (
          <div className="mt-6 grid gap-4">
            {leads.map((lead) => (
              <article
                key={lead.id}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex flex-col gap-5 lg:flex-row lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold text-slate-900">
                        {lead.name || "Unnamed lead"}
                      </h2>
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${statusChipClass(
                          lead.status || "open"
                        )}`}
                      >
                        {(lead.status || "open").toUpperCase()}
                      </span>
                    </div>

                    <p className="text-sm text-slate-600">
                      {[lead.phone, lead.email].filter(Boolean).join(" · ") || "-"}
                    </p>

                    <div className="grid gap-2 text-sm text-slate-700 md:grid-cols-2">
                      <p>
                        <span className="font-medium text-slate-500">Intent:</span>{" "}
                        {lead.primaryIntent || "-"}
                      </p>
                      <p>
                        <span className="font-medium text-slate-500">Preferred Channel:</span>{" "}
                        {lead.preferredChannel || "-"}
                      </p>
                      <p>
                        <span className="font-medium text-slate-500">Follow-Up Count:</span>{" "}
                        {lead.followUpCount ?? 0}
                      </p>
                      <p>
                        <span className="font-medium text-slate-500">Created:</span>{" "}
                        {formatDate(lead.createdAt)}
                      </p>
                    </div>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-700 lg:w-[320px]">
                    <p className="font-semibold text-slate-900">Status Reason</p>
                    <p className="mt-1 leading-6">{lead.statusReason || "-"}</p>
                    <p className="mt-3">
                      <span className="font-medium text-slate-500">Last Contacted:</span>{" "}
                      {formatDate(lead.lastContactedAt)}
                    </p>
                  </div>
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      Message
                    </p>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{lead.message || "-"}</p>
                  </div>

                  <div className="rounded-xl border border-slate-200 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      Suggested Reply
                    </p>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{lead.reply || "-"}</p>
                  </div>
                </div>

                <div className="mt-5 grid gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                      Manual Status
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium" onClick={() => updateStatus(lead.id, "open")}>Open</button>
                      <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium" onClick={() => updateStatus(lead.id, "contacted")}>Contacted</button>
                      <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium" onClick={() => updateStatus(lead.id, "booked")}>Booked</button>
                      <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium" onClick={() => updateStatus(lead.id, "closed")}>Closed</button>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                      AI Actions
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white" onClick={() => runFollowUp(lead.id)}>Run Follow-Up</button>
                      <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium" onClick={() => runAIStatus(lead.id)}>Auto-Set Status</button>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                      Schedule Follow-Up
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium" onClick={() => scheduleFollowUp(lead.id, "sms")}>Schedule SMS</button>
                      <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium" onClick={() => scheduleFollowUp(lead.id, "email")}>Schedule Email</button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}