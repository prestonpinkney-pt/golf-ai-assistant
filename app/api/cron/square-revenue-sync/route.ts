import { type NextRequest, NextResponse } from "next/server";
import { gateCron } from "../../lib/require-auth";
import { postCronInternalApi } from "@/lib/square/cron-internal-fetch";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Scheduled Square revenue + customer identity sync.
 * 1. Payments → revenue_events (rolling window)
 * 2. Customer directory pagination → customer_profiles (phone/email for recovery)
 *
 * Vercel cron schedule: every 6 hours (see vercel.json) — requires CRON_SECRET.
 */
export async function POST(request: NextRequest) {
  const denied = gateCron(request);
  if (denied) return denied;

  try {
    const revenue = await postCronInternalApi("/api/integrations/square/sync-revenue", {
      lookbackDays: 90,
      includeCustomerDirectory: true,
    });

    return NextResponse.json({
      ok: revenue.ok,
      status: revenue.status,
      revenue_sync: revenue.data,
    });
  } catch (error) {
    console.error("[cron/square-revenue-sync]", error);
    return NextResponse.json(
      {
        error: "Square revenue cron failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
