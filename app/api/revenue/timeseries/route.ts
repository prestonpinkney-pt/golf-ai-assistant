import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import { NextResponse } from "next/server";
import { BUSINESS_ID } from "../../config";
import { gateBusinessUser } from "../../lib/require-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

type RangeKey = "30d" | "month";

type RevenueEventRow = {
  amount_cents: number | null;
  occurred_at: string | null;
};

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

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...NO_STORE_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

function resolveRange(range: string | null): {
  range: RangeKey;
  start: DateTime;
  end: DateTime;
} {
  const now = DateTime.now().setZone("America/Los_Angeles");
  if (range === "month") {
    return {
      range: "month",
      start: now.startOf("month"),
      end: now.plus({ days: 1 }).startOf("day"),
    };
  }

  return {
    range: "30d",
    start: now.minus({ days: 29 }).startOf("day"),
    end: now.plus({ days: 1 }).startOf("day"),
  };
}

function buildEmptyPoints(start: DateTime, end: DateTime) {
  const points: { date: string; revenueCents: number }[] = [];
  let cursor = start;
  while (cursor < end) {
    points.push({ date: cursor.toISODate()!, revenueCents: 0 });
    cursor = cursor.plus({ days: 1 });
  }
  return points;
}

export async function GET(req: Request) {
  const denied = await gateBusinessUser();
  if (denied) return denied;

  try {
    const url = new URL(req.url);
    const rangeInfo = resolveRange(url.searchParams.get("range"));
    const points = buildEmptyPoints(rangeInfo.start, rangeInfo.end);
    const byDate = new Map(points.map((point) => [point.date, point]));

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("revenue_events")
      .select("amount_cents, occurred_at")
      .eq("business_id", BUSINESS_ID)
      .eq("status", "completed")
      .gte("occurred_at", rangeInfo.start.toUTC().toISO())
      .lt("occurred_at", rangeInfo.end.toUTC().toISO())
      .order("occurred_at", { ascending: true });

    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as RevenueEventRow[]) {
      if (!row.occurred_at) continue;
      const date = DateTime.fromISO(row.occurred_at, { zone: "utc" })
        .setZone("America/Los_Angeles")
        .toISODate();
      if (!date) continue;
      const point = byDate.get(date);
      if (!point) continue;
      point.revenueCents += Number(row.amount_cents ?? 0);
    }

    return jsonNoStore({
      range: rangeInfo.range,
      points,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return jsonNoStore(
      {
        error: "Failed to load revenue timeseries",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
