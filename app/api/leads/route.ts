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

export async function GET() {
  try {
    const leads = readLeads();

    return NextResponse.json(leads);
  } catch (error: any) {
    console.error("Read leads error:", error);

    return NextResponse.json(
      { error: error?.message || "Failed to load leads" },
      { status: 500 }
    );
  }
}