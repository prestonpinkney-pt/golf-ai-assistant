import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { gateBusinessUser } from "../lib/require-auth";

const filePath = path.join(process.cwd(), "data", "inquiries.json");

function readInquiries() {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "[]", "utf-8");
  }

  const fileData = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(fileData);
}

function writeInquiries(data: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function getNextFollowUpDate(hoursFromNow: number) {
  const date = new Date();
  date.setHours(date.getHours() + hoursFromNow);
  return date.toISOString();
}

export async function GET() {
  const denied = await gateBusinessUser();
  if (denied) return denied;

  try {
    const inquiries = readInquiries();
    return NextResponse.json(inquiries);
  } catch {
    return NextResponse.json(
      { error: "Failed to load inquiries" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const denied = await gateBusinessUser();
  if (denied) return denied;

  try {
    const body = await req.json();

    const {
      customerName,
      phone,
      email,
      preferredChannel,
      customerMessage,
      aiReply,
      inquiryType,
    } = body;

    if (!customerMessage || !aiReply || !inquiryType) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const inquiries = readInquiries();
    const now = new Date().toISOString();

    const newInquiry = {
      id: Date.now(),

      // 🔥 NEW CONTACT FIELDS
      customerName: customerName || "",
      phone: phone || "",
      email: email || "",
      preferredChannel: preferredChannel || "sms",

      // existing
      customerMessage,
      aiReply,
      inquiryType,

      createdAt: now,
      lastContactAt: now,
      nextFollowUpAt: getNextFollowUpDate(0),
      followUpCount: 0,
      followUpMessage: "",
      status: "open",
    };

    inquiries.unshift(newInquiry);
    writeInquiries(inquiries);

    return NextResponse.json(newInquiry);
  } catch {
    return NextResponse.json(
      { error: "Failed to save inquiry" },
      { status: 500 }
    );
  }
}