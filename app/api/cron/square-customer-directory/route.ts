import { type NextRequest, NextResponse } from "next/server";
import { gateCron } from "../../lib/require-auth";
import { postCronInternalApi } from "@/lib/square/cron-internal-fetch";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Daily Square Customer Directory sync (GET /v2/customers → customer_profiles).
 * Vercel cron schedule: daily at 06:00 UTC (see vercel.json) — requires CRON_SECRET.
 *
 * Manual: npm run sync:square-customers
 */
export async function GET(request: NextRequest) {
  const denied = gateCron(request);
  if (denied) return denied;

  try {
    const directory = await postCronInternalApi(
      "/api/integrations/square/sync-customer-directory"
    );

    return NextResponse.json({
      ok: directory.ok,
      customer_directory: directory.data,
    });
  } catch (error) {
    console.error("[cron/square-customer-directory]", error);
    return NextResponse.json(
      {
        error: "Square customer directory cron failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
