import { NextResponse } from "next/server";
import { sendSMS } from "../../../lib/twilio";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { to, message } = body;

    if (!to || !message) {
      return NextResponse.json(
        { error: "to and message are required" },
        { status: 400 }
      );
    }

    const result = await sendSMS(to, message);

    return NextResponse.json({
      success: true,
      sid: result.sid,
    });
  } catch (error: any) {
    console.error("SMS error:", error);

    return NextResponse.json(
      {
        error: error?.message || "Failed to send SMS",
      },
      { status: 500 }
    );
  }
}