"use client";

export default function Home() {
  async function handleLeadSubmit() {
    try {
      const res = await fetch("/api/leads/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test User",
          phone: "5105551234",
          email: "test@example.com",
          message: "I want to book a lesson",
        }),
      });

      const text = await res.text();
      console.log("Status:", res.status);
      console.log("Response:", text);

      if (!res.ok) {
        alert(`Lead submit failed: ${res.status} ${text}`);
        return;
      }

      alert("Lead submitted successfully");
    } catch (error) {
      console.error("Submit error:", error);
      alert("Something went wrong");
    }
  }

  return (
    <main style={{ padding: 40 }}>
      <h1>Primetime Golf AI</h1>

      <button
        onClick={handleLeadSubmit}
        style={{
          padding: "12px 20px",
          background: "black",
          color: "white",
          border: "none",
          cursor: "pointer",
        }}
      >
        Book a Lesson
      </button>
    </main>
  );
}