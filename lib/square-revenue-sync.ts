import type { SupabaseClient } from "@supabase/supabase-js";

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

export type SyncSquarePaymentsParams = {
  supabase: SupabaseClient;
  businessId: string;
  accessToken: string;
  locationId?: string | null;
  lookbackDays?: number;
  calendarMonthUtc?: boolean;
};

export type SyncSquarePaymentsResult = {
  processed: number;
  newRecords: number;
  updatedRecords: number;
  completedEligible: number;
  totalRevenueSyncedCents: number;
  lastSyncedAt: string;
  beginTime: string;
  endTime: string;
};

function getSquareApiBaseUrl() {
  if (process.env.SQUARE_ENVIRONMENT === "sandbox") {
    return "https://connect.squareupsandbox.com";
  }
  return "https://connect.squareup.com";
}

function getSyncWindow(lookbackDays: number, calendarMonthUtc: boolean) {
  const now = new Date();
  if (calendarMonthUtc) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { beginTime: start.toISOString(), endTime: end.toISOString() };
  }
  const end = now;
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  return { beginTime: start.toISOString(), endTime: end.toISOString() };
}

async function fetchSquarePaymentsInWindow(
  accessToken: string,
  beginTime: string,
  endTime: string,
  locationId?: string | null
) {
  const payments: SquarePayment[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      begin_time: beginTime,
      end_time: endTime,
      sort_order: "DESC",
      limit: "100",
    });
    if (locationId) params.set("location_id", locationId);
    if (cursor) params.set("cursor", cursor);

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

/**
 * Pull Square payments into public.revenue_events for a rolling or calendar window.
 */
export async function syncSquarePaymentsToRevenueEvents(
  params: SyncSquarePaymentsParams
): Promise<SyncSquarePaymentsResult> {
  const lookbackDays = Math.max(1, params.lookbackDays ?? 90);
  const calendarMonthUtc = params.calendarMonthUtc ?? false;
  const { beginTime, endTime } = getSyncWindow(lookbackDays, calendarMonthUtc);

  const payments = await fetchSquarePaymentsInWindow(
    params.accessToken,
    beginTime,
    endTime,
    params.locationId
  );

  const completedPayments = payments.filter(
    (payment) =>
      payment.status === "COMPLETED" &&
      payment.amount_money?.amount &&
      payment.amount_money.amount > 0
  );

  if (completedPayments.length === 0) {
    return {
      processed: 0,
      newRecords: 0,
      updatedRecords: 0,
      completedEligible: 0,
      totalRevenueSyncedCents: 0,
      lastSyncedAt: new Date().toISOString(),
      beginTime,
      endTime,
    };
  }

  const externalIds = completedPayments.map((p) => p.id);
  const { data: existingRows } = await params.supabase
    .from("revenue_events")
    .select("external_id")
    .eq("business_id", params.businessId)
    .eq("source", "square")
    .in("external_id", externalIds);

  const existingIds = new Set(
    (existingRows ?? []).map((row) => row.external_id as string)
  );

  const rows = completedPayments.map((payment) => ({
    business_id: params.businessId,
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

  const { error: upsertError } = await params.supabase
    .from("revenue_events")
    .upsert(rows, { onConflict: "source,external_id" });

  if (upsertError) {
    throw new Error(upsertError.message);
  }

  const newRecords = rows.filter((row) => !existingIds.has(row.external_id)).length;
  const totalRevenueSyncedCents = rows.reduce((sum, row) => sum + row.amount_cents, 0);

  return {
    processed: rows.length,
    newRecords,
    updatedRecords: rows.length - newRecords,
    completedEligible: completedPayments.length,
    totalRevenueSyncedCents,
    lastSyncedAt: new Date().toISOString(),
    beginTime,
    endTime,
  };
}
