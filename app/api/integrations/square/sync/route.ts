import { createClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { decryptToken } from "@/lib/square-token-crypto";
import { gateBusinessUserOrCron } from "../../../lib/require-auth";
import { BUSINESS_ID } from "../../../config";

const PRIMETIME_GOLF_BUSINESS_ID = BUSINESS_ID;

type SquarePayment = {
  id: string;
  status: string;
  created_at: string;
  updated_at?: string;
  amount_money?: {
    amount?: number;
    currency?: string;
  };
  buyer_email_address?: string;
  location_id?: string;
  order_id?: string;
  customer_id?: string;
};

type SquarePaymentsResponse = {
  payments?: SquarePayment[];
  cursor?: string;
};

function getSquareApiBaseUrl() {
  if (process.env.SQUARE_ENVIRONMENT === "sandbox") {
    return "https://connect.squareupsandbox.com";
  }

  return "https://connect.squareup.com";
}

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
    },
  });
}

function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );

  return {
    beginTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

async function fetchSquarePayments(accessToken: string) {
  const payments: SquarePayment[] = [];
  const { beginTime, endTime } = getCurrentMonthRange();

  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      begin_time: beginTime,
      end_time: endTime,
      sort_order: "DESC",
      limit: "100",
    });

    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await fetch(
      `${getSquareApiBaseUrl()}/v2/payments?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Square-Version": "2025-01-23",
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const details = await response.text();

      throw new Error(`Square payments sync failed: ${details}`);
    }

    const data = (await response.json()) as SquarePaymentsResponse;

    payments.push(...(data.payments ?? []));
    cursor = data.cursor;
  } while (cursor);

  return payments;
}

export async function POST(request: NextRequest) {
  const denied = await gateBusinessUserOrCron(request);
  if (denied) return denied;

  const supabase = getSupabaseAdmin();

  const { data: connection, error: connectionError } = await supabase
    .from("square_connections")
    .select("access_token_encrypted, location_id, revoked_at")
    .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
    .single();

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

  const accessToken = decryptToken(connection.access_token_encrypted);
  const payments = await fetchSquarePayments(accessToken);

  const completedPayments = payments.filter(
    (payment) =>
      payment.status === "COMPLETED" &&
      payment.amount_money?.amount &&
      payment.amount_money.amount > 0
  );

  if (completedPayments.length === 0) {
    return NextResponse.json({
      synced: 0,
      message: "No completed Square payments found for the current month",
    });
  }

  const rows = completedPayments.map((payment) => ({
    business_id: PRIMETIME_GOLF_BUSINESS_ID,
    source: "square",
    external_id: payment.id,
    customer_name:
      payment.buyer_email_address ??
      payment.customer_id ??
      payment.order_id ??
      "Square Customer",
    amount_cents: payment.amount_money?.amount ?? 0,
    currency: payment.amount_money?.currency ?? "USD",
    category: "unknown",
    status: "completed",
    occurred_at: payment.created_at,
    raw_payload: payment,
    updated_at: new Date().toISOString(),
  }));

  const { error: upsertError } = await supabase
    .from("revenue_events")
    .upsert(rows, {
      onConflict: "source,external_id",
    });

  if (upsertError) {
    return NextResponse.json(
      {
        error: "Failed to save Square payments",
        details: upsertError.message,
      },
      { status: 500 }
    );
  }

  const totalSyncedCents = rows.reduce(
    (sum, row) => sum + row.amount_cents,
    0
  );

  return NextResponse.json({
    synced: rows.length,
    totalSyncedCents,
    totalSyncedDollars: totalSyncedCents / 100,
  });
}