"use client";

import React, { useState } from "react";

type BrainResult = {
  intents: string[];
  primaryIntent: string;
  secondaryIntents: string[];
  complexity: string;
  leadTemperature: string;
  persona: string;
  pressureMode: string;
  goal: string;
  shouldEscalate: boolean;
  reply: string;
  error?: string;
};

export default function TestAIPage() {
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<BrainResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");

  async function handleSend() {
    setLoading(true);
    setResult(null);
    setSaveStatus("");

    try {
      const res = await fetch("/api/ai/respond", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      });

      const data = await res.json();
      setResult(data);

      if (!data.error) {
        const saveRes = await fetch("/api/leads/save", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message,
            reply: data.reply,
            intents: data.intents,
            primaryIntent: data.primaryIntent,
            secondaryIntents: data.secondaryIntents,
            complexity: data.complexity,
            leadTemperature: data.leadTemperature,
            persona: data.persona,
            pressureMode: data.pressureMode,
            goal: data.goal,
            shouldEscalate: data.shouldEscalate,
          }),
        });

        const saveData = await saveRes.json();

        if (saveRes.ok) {
          setSaveStatus("Lead saved");
        } else {
          setSaveStatus(saveData.error || "Save failed");
        }
      }
    } catch (error: any) {
      setResult({
        intents: [],
        primaryIntent: "",
        secondaryIntents: [],
        complexity: "",
        leadTemperature: "",
        persona: "",
        pressureMode: "",
        goal: "",
        shouldEscalate: false,
        reply: "",
        error: error?.message || "Something went wrong",
      });
    }

    setLoading(false);
  }

  return (
    <div style={{ padding: 40 }}>
      <h1>Test Primetime Golf AI</h1>

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Type a customer message..."
        style={{ width: "100%", height: 120 }}
      />

      <button onClick={handleSend} style={{ marginTop: 10 }}>
        {loading ? "Thinking..." : "Send to AI"}
      </button>

      {result && (
        <div
          style={{
            marginTop: 20,
            border: "1px solid #ccc",
            padding: 16,
            borderRadius: 8,
          }}
        >
          {result.error ? (
            <p>
              <strong>Error:</strong> {result.error}
            </p>
          ) : (
            <>
              <p>
                <strong>Intents:</strong> {result.intents?.join(", ")}
              </p>
              <p>
                <strong>Primary Intent:</strong> {result.primaryIntent}
              </p>
              <p>
                <strong>Secondary Intents:</strong>{" "}
                {result.secondaryIntents?.join(", ")}
              </p>
              <p>
                <strong>Complexity:</strong> {result.complexity}
              </p>
              <p>
                <strong>Lead Temperature:</strong> {result.leadTemperature}
              </p>
              <p>
                <strong>Persona:</strong> {result.persona}
              </p>
              <p>
                <strong>Pressure Mode:</strong> {result.pressureMode}
              </p>
              <p>
                <strong>Goal:</strong> {result.goal}
              </p>
              <p>
                <strong>Should Escalate:</strong>{" "}
                {result.shouldEscalate ? "Yes" : "No"}
              </p>

              <div style={{ marginTop: 16 }}>
                <strong>Reply:</strong>
                <div
                  style={{
                    marginTop: 8,
                    padding: 12,
                    border: "1px solid #ddd",
                    borderRadius: 8,
                  }}
                >
                  {result.reply}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <div
        style={{
          marginTop: 20,
          border: "1px solid #ccc",
          padding: 16,
          borderRadius: 8,
        }}
      >
        <strong>Save Status:</strong>
        <div>{saveStatus}</div>
      </div>
    </div>
  );
}