"use client";

import { useState } from "react";

export default function Home() {
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    message: "",
  });

  async function handleLeadSubmit(e: React.FormEvent) {
    e.preventDefault();

    const res = await fetch("/api/leads/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(form),
    });

    const data = await res.json();

    if (!res.ok) {
      alert(`Lead submit failed: ${data.error}`);
      return;
    }

    alert("Lead submitted successfully");
  }

  return (
    <main style={{ padding: 40, maxWidth: 500, margin: "0 auto" }}>
      <h1>Primetime Golf AI</h1>

      <form onSubmit={handleLeadSubmit} style={{ display: "grid", gap: 12 }}>
        <input
          type="text"
          placeholder="Name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />

        <input
          type="tel"
          placeholder="Phone"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          required
        />

        <input
          type="email"
          placeholder="Email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          required
        />

        <textarea
          placeholder="What are you looking for?"
          value={form.message}
          onChange={(e) => setForm({ ...form, message: e.target.value })}
          required
          rows={5}
        />

        <button type="submit">Submit Lead</button>
      </form>
    </main>
  );
}