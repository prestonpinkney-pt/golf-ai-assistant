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

function getFutureISO(hoursFromNow: number) {
  const d = new Date();
  d.setHours(d.getHours() + hoursFromNow);
  return d.toISOString();
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { id, channel, hoursFromNow } = body;

    if (!id) {
      return NextResponse.json(
        { error: "Lead id is required" },
        { status: 400 }
      );
    }

    const leads = readLeads();

    const updatedLeads = leads.map((lead: any) => {
      if (lead.id !== id) return lead;

      return {
        ...lead,
        preferredChannel: channel || lead.preferredChannel || "sms",
        nextFollowUpAt: getFutureISO(
          typeof hoursFromNow === "number" ? hoursFromNow : 24
        ),
      };
    });

    writeLeads(updatedLeads);

    const updatedLead = updatedLeads.find((lead: any) => lead.id === id);

    return NextResponse.json({
      success: true,
      lead: updatedLead,
    });
  } catch (error: any) {
    console.error("Schedule follow-up error:", error);

    return NextResponse.json(
      { error: error?.message || "Failed to schedule follow-up" },
      { status: 500 }
    );
  }
}