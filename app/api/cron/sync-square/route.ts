import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const response = await fetch(
    `${baseUrl}/api/integrations/square/sync-customers`,
    {
      method: "POST",
      headers: cronSecret
        ? { Authorization: `Bearer ${cronSecret}` }
        : undefined,
    }
  );

  const data = await response.json();

  return NextResponse.json({
    success: response.ok,
    sync: data,
  });
}