import { NextResponse, type NextRequest } from "next/server";
import { gateCron } from "../../lib/require-auth";
import { postCronInternalApi } from "@/lib/square/cron-internal-fetch";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Legacy cron alias — runs Square customer directory sync (not legacy sync-customers).
 * Prefer /api/cron/square-customer-directory for daily identity enrichment.
 */
export async function GET(request: NextRequest) {
  const denied = gateCron(request);
  if (denied) return denied;

  try {
    const directory = await postCronInternalApi(
      "/api/integrations/square/sync-customer-directory"
    );

    return NextResponse.json({
      success: directory.ok,
      sync: directory.data,
    });
  } catch (error) {
    console.error("[cron/sync-square]", error);
    return NextResponse.json(
      {
        error: "Square directory cron failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
