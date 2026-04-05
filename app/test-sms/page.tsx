"use client";

import { useState } from "react";

export default function TestSMSPage() {
  const [to, setTo] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");

  async function handleSend() {
    setStatus("Sending...");

    try {
      const res = await fetch("/api/send-sms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to, message }),
      });

      const data = await res.json();

      if (res.ok) {
        setStatus("SMS sent successfully");
      } else {
        setStatus(data.error || "SMS failed");
      }
    } catch (error) {
      setStatus("Something went wrong");
    }
  }

  return (
    <main style={{ padding: "40px", maxWidth: "600px", margin: "0 auto" }}>
      <h1>Test SMS</h1>

      <input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="Phone number like +15105551234"
        style={{ width: "100%", padding: "10px", marginTop: "10px" }}
      />

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Message"
        style={{
          width: "100%",
          padding: "10px",
          marginTop: "10px",
          height: "120px",
        }}
      />

      <button
        onClick={handleSend}
        style={{ marginTop: "15px", padding: "10px 20px" }}
      >
        Send SMS
      </button>

      <p style={{ marginTop: "20px" }}>
        <strong>Status:</strong> {status}
      </p>
    </main>
  );
}