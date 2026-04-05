import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const filePath = path.join(process.cwd(), "data", "leads.json");

function readLeads() {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "[]", "utf-8");
  }

  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeLeads(data: any) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function getNextFollowUpDate(hoursFromNow: number) {
  const date = new Date();
  date.setHours(date.getHours() + hoursFromNow);
  return date.toISOString();
}

function buildFollowUpMessage(lead: any) {
  const intent = lead.primaryIntent;

  if (intent === "lesson") {
    return "Just following up — I can still help you get a lesson lined up. Want me to help you lock in a time?";
  }

  if (intent === "event") {
    return "Following up on your event inquiry — if you send me the date and group details, I can help move it in the right direction.";
  }

  if (intent === "tee_time") {
    return "Quick follow-up — if you're still looking for a tee time, send me the day and time window you want.";
  }

  if (intent === "membership") {
    return "Following up — if you're still looking at membership options, I can help point you toward the best fit.";
  }

  return "Just following up — if you still want help, send me a little more detail and I’ll keep it moving.";
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json(
        { error: "Lead id is required" },
        { status: 400 }
      );
    }

    const leads = readLeads();

    const updatedLeads = leads.map((lead: any) => {
      if (lead.id !== id) return lead;

      const followUpMessage = buildFollowUpMessage(lead);
      const now = new Date().toISOString();
      const newCount = (lead.followUpCount || 0) + 1;

      return {
        ...lead,
        followUpMessage,
        followUpCount: newCount,
        lastFollowUpAt: now,
        nextFollowUpAt: newCount >= 2 ? null : getNextFollowUpDate(24),
        status: lead.status === "open" ? "contacted" : lead.status,
      };
    });

    writeLeads(updatedLeads);

    const updatedLead = updatedLeads.find((lead: any) => lead.id === id);

    return NextResponse.json({
      success: true,
      lead: updatedLead,
    });
  } catch (error: any) {
    console.error("Follow-up trigger error:", error);

    return NextResponse.json(
      { error: error?.message || "Failed to trigger follow-up" },
      { status: 500 }
    );
  }
}