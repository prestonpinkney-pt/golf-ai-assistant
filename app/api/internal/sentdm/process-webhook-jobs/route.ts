import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { claimAndProcessSentDmWebhookJobs } from "@/lib/sentdm/process-webhook-job";
import { isWebhookJobDrainAuthorized } from "@/lib/sentdm/webhook-job-auth";

/**
 * POST /api/internal/sentdm/process-webhook-jobs
 * Claims pending `webhook_jobs` rows and runs enrich → AI → outbound (cron / ops fallback).
 *
 * Auth: CRON_SECRET (Vercel cron), CLOSEOS_WEBHOOK_JOB_SECRET, or INTERNAL_API_SECRET.
 */

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

function authorize(req: NextRequest): boolean {
  return isWebhookJobDrainAuthorized(req);
}

export async function POST(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let limit = 10;
  try {
    const json = (await req.json()) as { limit?: unknown };
    if (typeof json?.limit === "number" && Number.isFinite(json.limit)) {
      limit = json.limit;
    }
  } catch {
    /* empty body */
  }

  limit = Math.min(50, Math.max(1, Math.floor(limit)));

  try {
    const supabase = getSupabase();
    const processed = await claimAndProcessSentDmWebhookJobs(supabase, limit);
    return NextResponse.json({ ok: true, processed }, { status: 200 });
  } catch (e) {
    console.error("[internal/sentdm/process-webhook-jobs]", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

/** Allow GET for simple uptime monitors / curl smoke tests (same auth). */
export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabase();
    const processed = await claimAndProcessSentDmWebhookJobs(supabase, 10);
    return NextResponse.json({ ok: true, processed }, { status: 200 });
  } catch (e) {
    console.error("[internal/sentdm/process-webhook-jobs]", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
