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
    return "Following up on your event inquiry — if you send over the date and group details, I can help move it in the right direction.";
  }

  if (intent === "tee_time") {
    return "Quick follow-up — if you're still looking for a tee time, send me the day and time window you want.";
  }

  if (intent === "membership") {
    return "Following up — if you're still looking at membership options, I can help point you toward the best fit.";
  }

  return "Just following up — if you still want help, send me a little more detail and I’ll keep it moving.";
}

export async function POST() {
  try {
    const leads = readLeads();
    const now = new Date();

    let processedCount = 0;

    const updatedLeads = leads.map((lead: any) => {
      if (!lead.nextFollowUpAt) return lead;
      if (lead.status === "booked" || lead.status === "closed") return lead;

      const dueDate = new Date(lead.nextFollowUpAt);

      if (dueDate > now) return lead;

      const followUpMessage = buildFollowUpMessage(lead);
      const newCount = (lead.followUpCount || 0) + 1;

      processedCount += 1;

      return {
        ...lead,
        followUpMessage,
        followUpCount: newCount,
        lastFollowUpAt: now.toISOString(),
        lastContactedAt: now.toISOString(),
        status: lead.status === "open" ? "contacted" : lead.status,
        nextFollowUpAt: newCount >= 2 ? null : getNextFollowUpDate(24),
        lastSendChannel: lead.preferredChannel || "sms",
        lastSendResult: `Follow-up prepared for ${lead.preferredChannel || "sms"}`,
      };
    });

    writeLeads(updatedLeads);

    return NextResponse.json({
      success: true,
      processedCount,
    });
  } catch (error: any) {
    console.error("Run due follow-ups error:", error);

    return NextResponse.json(
      { error: error?.message || "Failed to run due follow-ups" },
      { status: 500 }
    );
  }
}