import { createClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { decryptToken } from "@/lib/square-token-crypto";
import { syncSquarePaymentsToRevenueEvents } from "@/lib/square-revenue-sync";
import {
  countHighValueReachable,
  syncSquareCustomerDirectory,
} from "@/lib/square/customer-directory-sync";
import {
  ApiAuthError,
  isCronAuthorizedRequest,
  requireBusinessUser,
} from "../../../lib/require-auth";
import { BUSINESS_ID } from "../../../config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Manual or cron: pull Square payments into public.revenue_events (90-day window by default).
 * When `includeCustomerDirectory` is true (default for cron), also paginates GET /v2/customers
 * to enrich customer_profiles phone/email for Revenue Recovery.
 */
export async function POST(request: NextRequest) {
  let businessId: string;
  if (isCronAuthorizedRequest(request)) {
    if (!process.env.CRON_SECRET) {
      return NextResponse.json(
        { error: "CRON_SECRET is not configured on the server" },
        { status: 500 }
      );
    }
    businessId = BUSINESS_ID;
  } else {
    try {
      businessId = (await requireBusinessUser()).businessId;
    } catch (e) {
      if (e instanceof ApiAuthError) {
        return NextResponse.json(
          { error: e.message },
          { status: e.statusCode }
        );
      }
      throw e;
    }
  }

  let lookbackDays = 90;
  let includeCustomerDirectory = isCronAuthorizedRequest(request);
  try {
    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = (await request.json()) as {
        lookbackDays?: number;
        includeCustomerDirectory?: boolean;
      };
      if (
        typeof body.lookbackDays === "number" &&
        Number.isFinite(body.lookbackDays)
      ) {
        lookbackDays = Math.min(
          365,
          Math.max(30, Math.round(body.lookbackDays))
        );
      }
      if (typeof body.includeCustomerDirectory === "boolean") {
        includeCustomerDirectory = body.includeCustomerDirectory;
      }
    }
  } catch {
    // default window
  }

  const supabase = getSupabaseAdmin();

  const { data: connection, error: connectionError } = await supabase
    .from("square_connections")
    .select("access_token_encrypted, location_id, revoked_at")
    .eq("business_id", businessId)
    .maybeSingle();

  if (connectionError || !connection) {
    return NextResponse.json(
      {
        error: "Square is not connected",
        details: connectionError?.message,
      },
      { status: 400 }
    );
  }

  if (connection.revoked_at) {
    return NextResponse.json(
      { error: "Square connection has been revoked" },
      { status: 400 }
    );
  }

  try {
    const accessToken = decryptToken(connection.access_token_encrypted);
    const stats = await syncSquarePaymentsToRevenueEvents({
      supabase,
      businessId,
      accessToken,
      locationId: connection.location_id,
      lookbackDays,
      calendarMonthUtc: false,
    });

    let customerDirectory: Record<string, unknown> | null = null;
    if (includeCustomerDirectory) {
      const { data: beforeRows } = await supabase
        .from("customer_profiles")
        .select(
          "total_spend_cents, last_purchase_at, first_name, last_name, email, phone, raw_payload, source"
        )
        .eq("business_id", businessId)
        .eq("source", "square");

      const reachableBefore = countHighValueReachable(beforeRows ?? []);

      const directoryStats = await syncSquareCustomerDirectory({
        supabase,
        businessId,
        accessToken,
        environment: process.env.SQUARE_ENVIRONMENT,
      });

      const { data: afterRows } = await supabase
        .from("customer_profiles")
        .select(
          "total_spend_cents, last_purchase_at, first_name, last_name, email, phone, raw_payload, source"
        )
        .eq("business_id", businessId)
        .eq("source", "square");

      customerDirectory = {
        ...directoryStats,
        high_value_reachable_before: reachableBefore,
        high_value_reachable_after: countHighValueReachable(afterRows ?? []),
      };
    }

    return NextResponse.json({
      ok: true,
      recordsProcessed: stats.processed,
      newRecords: stats.newRecords,
      updatedRecords: stats.updatedRecords,
      completedPaymentsUpserted: stats.completedEligible,
      totalRevenueSyncedCents: stats.totalRevenueSyncedCents,
      lastSyncedAt: stats.lastSyncedAt,
      window: {
        beginTime: stats.beginTime,
        endTime: stats.endTime,
        lookbackDays,
      },
      customer_directory: customerDirectory,
    });
  } catch (e) {
    console.error("square sync-revenue:", e);
    return NextResponse.json(
      {
        error: "Square revenue sync failed",
        details: e instanceof Error ? e.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
