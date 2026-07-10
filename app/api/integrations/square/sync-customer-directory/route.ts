import { createClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

import { BUSINESS_ID } from "../../../config";
import {
  ApiAuthError,
  isCronAuthorizedRequest,
  requireBusinessUser,
} from "../../../lib/require-auth";
import { decryptToken } from "@/lib/square-token-crypto";
import {
  countHighValueReachable,
  syncSquareCustomerDirectory,
} from "@/lib/square/customer-directory-sync";

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

async function resolveBusinessId(request: NextRequest) {
  if (isCronAuthorizedRequest(request)) {
    if (!process.env.CRON_SECRET) {
      return {
        response: NextResponse.json(
          { error: "CRON_SECRET is not configured on the server" },
          { status: 500 }
        ),
      };
    }
    return { businessId: BUSINESS_ID };
  }

  try {
    return { businessId: (await requireBusinessUser()).businessId };
  } catch (e) {
    if (e instanceof ApiAuthError) {
      return {
        response: NextResponse.json(
          { error: e.message },
          { status: e.statusCode }
        ),
      };
    }
    throw e;
  }
}

export async function POST(request: NextRequest) {
  const auth = await resolveBusinessId(request);
  if ("response" in auth) return auth.response;

  const supabase = getSupabaseAdmin();

  const { data: connection, error: connectionError } = await supabase
    .from("square_connections")
    .select("access_token_encrypted, revoked_at")
    .eq("business_id", auth.businessId)
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
    const { data: beforeRows } = await supabase
      .from("customer_profiles")
      .select(
        "total_spend_cents, last_purchase_at, first_name, last_name, email, phone, raw_payload, source"
      )
      .eq("business_id", auth.businessId)
      .eq("source", "square");

    const accessToken = decryptToken(connection.access_token_encrypted as string);
    const directoryStats = await syncSquareCustomerDirectory({
      supabase,
      businessId: auth.businessId,
      accessToken,
      environment: process.env.SQUARE_ENVIRONMENT,
    });

    const { data: afterRows } = await supabase
      .from("customer_profiles")
      .select(
        "total_spend_cents, last_purchase_at, first_name, last_name, email, phone, raw_payload, source"
      )
      .eq("business_id", auth.businessId)
      .eq("source", "square");

    return NextResponse.json({
      ok: true,
      ...directoryStats,
      high_value_reachable_before: countHighValueReachable(beforeRows ?? []),
      high_value_reachable_after: countHighValueReachable(afterRows ?? []),
    });
  } catch (e) {
    console.error("square sync-customer-directory:", e);
    return NextResponse.json(
      {
        error: "Square customer directory sync failed",
        details: e instanceof Error ? e.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
