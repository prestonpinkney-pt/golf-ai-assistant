import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const filePath = path.join(process.cwd(), "data", "leads.json");

function readLeads() {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "[]", "utf-8");
  }

  const fileData = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(fileData);
}

function writeLeads(data: any) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { id, status } = body;

    if (!id || !status) {
      return NextResponse.json(
        { error: "id and status are required" },
        { status: 400 }
      );
    }

    const validStatuses = ["open", "contacted", "booked", "closed"];

    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { error: "Invalid status" },
        { status: 400 }
      );
    }

    const leads = readLeads();

    const updatedLeads = leads.map((lead: any) => {
      if (lead.id === id) {
        return {
          ...lead,
          status,
        };
      }
      return lead;
    });

    writeLeads(updatedLeads);

    return NextResponse.json({
      success: true,
    });
  } catch (error: any) {
    console.error("Update status error:", error);

    return NextResponse.json(
      { error: error?.message || "Failed to update status" },
      { status: 500 }
    );
  }
}