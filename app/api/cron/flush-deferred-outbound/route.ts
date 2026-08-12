import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { gateCron } from "../../lib/require-auth";
import { flushDeferredQuietHoursOutbound } from "@/lib/sentdm/flush-deferred-outbound";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function getSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

/**
 * Flushes AI outbound drafts deferred during quiet hours once the window opens.
 * Hobby-compatible daily cron (see vercel.json `0 16 * * *` ≈ after default
 * 08:00 America/Los_Angeles quiet-hours end). Handler no-ops while quiet hours
 * are still active. Auth: Bearer CRON_SECRET.
 */
export async function GET(request: NextRequest) {
  const denied = gateCron(request);
  if (denied) return denied;

  try {
    const result = await flushDeferredQuietHoursOutbound(getSupabase(), 40);
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (e) {
    console.error("[cron/flush-deferred-outbound]", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
