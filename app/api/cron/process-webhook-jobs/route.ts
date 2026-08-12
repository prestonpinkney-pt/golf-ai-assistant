import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { gateCron } from "../../lib/require-auth";
import { claimAndProcessSentDmWebhookJobs } from "@/lib/sentdm/process-webhook-job";

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
 * Vercel cron drain for Sent.dm webhook_jobs.
 * Hobby plans only allow once-daily cron expressions — keep `0 8 * * *` in
 * vercel.json and loop batches here so a large backlog can still clear in one run.
 * Auth: Authorization Bearer CRON_SECRET (injected by Vercel Cron).
 */
async function drain(limitPerBatch: number, maxBatches = 20) {
  const supabase = getSupabase();
  let processed = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await claimAndProcessSentDmWebhookJobs(supabase, limitPerBatch);
    processed += n;
    if (n < limitPerBatch) break;
  }
  return processed;
}

export async function GET(request: NextRequest) {
  const denied = gateCron(request);
  if (denied) return denied;

  try {
    const processed = await drain(50);
    return NextResponse.json({ ok: true, processed }, { status: 200 });
  } catch (e) {
    console.error("[cron/process-webhook-jobs]", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
