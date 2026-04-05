import { NextResponse } from "next/server";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

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
    const lead = leads.find((l: any) => l.id === id);

    if (!lead) {
      return NextResponse.json(
        { error: "Lead not found" },
        { status: 404 }
      );
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You classify lead status. Return only JSON.",
        },
        {
          role: "user",
          content: `
Message: ${lead.message}
Reply: ${lead.reply}
Intent: ${lead.primaryIntent}
Follow-ups: ${lead.followUpCount}
Current Status: ${lead.status}

Pick one:
open, contacted, booked, closed

Return:
{ "status": "", "reason": "" }
`,
        },
      ],
    });

    const raw = completion.choices[0].message.content || "{}";
    const parsed = JSON.parse(raw);

    const updated = leads.map((l: any) =>
      l.id === id
        ? {
            ...l,
            status: parsed.status || l.status,
            statusReason: parsed.reason || "",
          }
        : l
    );

    writeLeads(updated);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
}