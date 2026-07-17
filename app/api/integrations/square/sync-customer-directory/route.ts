import { type NextRequest, NextResponse } from "next/server";

import { BUSINESS_ID } from "../../../config";
import {
  ApiAuthError,
  isCronAuthorizedRequest,
  requireBusinessUser,
} from "../../../lib/require-auth";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { decryptToken } from "@/lib/square-token-crypto";
import { syncSquareCustomerDirectory } from "@/lib/square/customer-directory-sync";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: NextRequest) {
  let businessId: string;
  if (isCronAuthorizedRequest(request)) {
    businessId = BUSINESS_ID;
  } else {
    try {
      businessId = (await requireBusinessUser()).businessId;
    } catch (error) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.statusCode }
        );
      }
      throw error;
    }
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: connection, error: connectionError } = await supabase
    .from("square_connections")
    .select("access_token_encrypted, revoked_at")
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
    const stats = await syncSquareCustomerDirectory({
      supabase,
      businessId,
      accessToken: decryptToken(connection.access_token_encrypted),
      environment: process.env.SQUARE_ENVIRONMENT,
    });

    return NextResponse.json({ ok: true, ...stats });
  } catch (error) {
    console.error("[square/sync-customer-directory]", error);
    return NextResponse.json(
      {
        error: "Square customer directory sync failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
