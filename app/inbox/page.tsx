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
    <main style={{ padding: "40px", maxWidth: "1200px", margin: "0 auto" }}>
      <h1 style={{ fontSize: "36px", marginBottom: "20px" }}>Leads Inbox</h1>

      <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
        <button onClick={loadLeads} style={{ padding: "10px 18px", cursor: "pointer" }}>
          Refresh
        </button>

        <button onClick={runDueFollowUps} style={{ padding: "10px 18px", cursor: "pointer" }}>
          Run Due Follow-Ups
        </button>
      </div>

      {runStatus && (
        <p>
          <strong>Follow-Up Runner:</strong> {runStatus}
        </p>
      )}

      {loading && <p>Loading leads...</p>}

      {error && (
        <p style={{ color: "red" }}>
          <strong>Error:</strong> {error}
        </p>
      )}

      {!loading && !error && leads.length === 0 && <p>No leads yet.</p>}

      {!loading && !error && leads.length > 0 && (
        <div style={{ display: "grid", gap: "16px" }}>
          {leads.map((lead) => (
            <div
              key={lead.id}
              style={{
                border: "1px solid #ddd",
                borderRadius: "12px",
                padding: "20px",
                background: "#fff",
              }}
            >
              <p><strong>Name:</strong> {lead.name || "-"}</p>
              <p><strong>Phone:</strong> {lead.phone || "-"}</p>
              <p><strong>Email:</strong> {lead.email || "-"}</p>
              <p><strong>Preferred Channel:</strong> {lead.preferredChannel || "-"}</p>
              <p><strong>Message:</strong> {lead.message}</p>
              <p><strong>Reply:</strong> {lead.reply}</p>
              <p><strong>Intents:</strong> {lead.intents?.join(", ") || "-"}</p>
              <p><strong>Primary Intent:</strong> {lead.primaryIntent || "-"}</p>
              <p><strong>Complexity:</strong> {lead.complexity || "-"}</p>
              <p><strong>Lead Temperature:</strong> {lead.leadTemperature || "-"}</p>
              <p><strong>Persona:</strong> {lead.persona || "-"}</p>
              <p><strong>Pressure Mode:</strong> {lead.pressureMode || "-"}</p>
              <p><strong>Goal:</strong> {lead.goal || "-"}</p>
              <p><strong>Should Escalate:</strong> {lead.shouldEscalate ? "Yes" : "No"}</p>
              <p><strong>Status:</strong> {lead.status || "-"}</p>
              <p><strong>Status Reason:</strong> {lead.statusReason || "-"}</p>

              <div style={{ marginTop: "12px", marginBottom: "12px" }}>
                <strong>Manual Status:</strong>
                <div style={{ display: "flex", gap: "10px", marginTop: "8px", flexWrap: "wrap" }}>
                  <button onClick={() => updateStatus(lead.id, "open")}>Open</button>
                  <button onClick={() => updateStatus(lead.id, "contacted")}>Contacted</button>
                  <button onClick={() => updateStatus(lead.id, "booked")}>Booked</button>
                  <button onClick={() => updateStatus(lead.id, "closed")}>Closed</button>
                </div>
              </div>

              <div style={{ marginTop: "12px", marginBottom: "12px" }}>
                <strong>AI Actions:</strong>
                <div style={{ display: "flex", gap: "10px", marginTop: "8px", flexWrap: "wrap" }}>
                  <button onClick={() => runFollowUp(lead.id)}>Run Follow-Up</button>
                  <button onClick={() => runAIStatus(lead.id)}>Auto-Set Status</button>
                </div>
              </div>

              <div style={{ marginTop: "12px", marginBottom: "12px" }}>
                <strong>Schedule Follow-Up:</strong>
                <div style={{ display: "flex", gap: "10px", marginTop: "8px", flexWrap: "wrap" }}>
                  <button onClick={() => scheduleFollowUp(lead.id, "sms")}>
                    Schedule SMS
                  </button>
                  <button onClick={() => scheduleFollowUp(lead.id, "email")}>
                    Schedule Email
                  </button>
                </div>
              </div>

              <p><strong>Follow-Up Count:</strong> {lead.followUpCount ?? 0}</p>
              <p><strong>Follow-Up Message:</strong> {lead.followUpMessage || "-"}</p>
              <p><strong>Next Follow-Up:</strong> {lead.nextFollowUpAt || "-"}</p>
              <p><strong>Last Follow-Up:</strong> {lead.lastFollowUpAt || "-"}</p>
              <p><strong>Last Contacted At:</strong> {lead.lastContactedAt || "-"}</p>
              <p><strong>Last Send Channel:</strong> {lead.lastSendChannel || "-"}</p>
              <p><strong>Last Send Result:</strong> {lead.lastSendResult || "-"}</p>
              <p><strong>Created At:</strong> {lead.createdAt || "-"}</p>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}