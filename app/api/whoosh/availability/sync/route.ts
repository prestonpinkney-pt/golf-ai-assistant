import { ApiAuthError, requireBusinessUser } from "@/app/api/lib/require-auth";
import { jsonNoStore } from "@/app/api/campaigns/_http";
import { isDevelopmentRuntime } from "@/lib/campaigns/setup-diagnostics";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { isWhooshServerConfigured } from "@/lib/whoosh/client";
import { syncWhooshAvailabilityWindows } from "@/lib/whoosh/sync-availability-windows";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST() {
  let businessId: string;
  try {
    businessId = (await requireBusinessUser()).businessId;
  } catch (e) {
    if (e instanceof ApiAuthError) {
      return jsonNoStore(
        { ok: false, error: "auth_failed", message: e.message },
        { status: e.statusCode }
      );
    }
    throw e;
  }

  if (!isWhooshServerConfigured()) {
    return jsonNoStore(
      {
        ok: false,
        error: "whoosh_not_configured",
        message:
          "Connect Whoosh availability before generating slow-time campaigns (WHOOSH_API_BASE_URL, WHOOSH_API_TOKEN, WHOOSH_FACILITY_SLUG or WHOOSH_FACILITY_ID).",
      },
      { status: 503 }
    );
  }

  const supabase = createSupabaseServiceRoleClient();

  const result = await syncWhooshAvailabilityWindows({
    supabase,
    businessId,
    daysAhead: 10,
  });

  if (!result.ok) {
    return jsonNoStore(
      {
        ok: false,
        error: "whoosh_sync_failed",
        message:
          "Whoosh availability could not be verified. CloseOS will not generate slow-time campaigns until availability is confirmed.",
        ...(isDevelopmentRuntime() && result.details
          ? { debugError: result.details }
          : {}),
      },
      { status: 502 }
    );
  }

  if (result.windowsSynced === 0) {
    return jsonNoStore(
      {
        ok: false,
        error: "no_whoosh_windows",
        message:
          "Whoosh returned no bookable simulator windows for the next 10 days.",
        windowsSynced: 0,
        startDate: result.startDate,
        endDate: result.endDate,
        source: result.source,
      },
      { status: 404 }
    );
  }

  return jsonNoStore({
    ok: true,
    windowsSynced: result.windowsSynced,
    startDate: result.startDate,
    endDate: result.endDate,
    source: result.source,
  });
}
