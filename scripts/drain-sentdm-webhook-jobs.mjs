#!/usr/bin/env node
/**
 * Local dev drain for Sent.dm webhook_jobs left in `pending` when Next.js `after()`
 * does not finish background work (common in `next dev`).
 *
 * Does not change production webhook routes — uses the same processors as cron/internal drain.
 *
 * Usage:
 *   node --import ./tests/stub-server-only.cjs --import tsx scripts/drain-sentdm-webhook-jobs.mjs
 *   node --import ./tests/stub-server-only.cjs --import tsx scripts/drain-sentdm-webhook-jobs.mjs --limit 25
 *   node --import ./tests/stub-server-only.cjs --import tsx scripts/drain-sentdm-webhook-jobs.mjs --resume-processing
 *
 * npm run drain:sentdm-webhook-jobs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] == null || process.env[key] === "") {
        process.env[key] = val;
      }
    }
  } catch {
    /* optional */
  }
}

function parseArgs(argv) {
  let limit = 10;
  let jobId = null;
  let resumeProcessing = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit" && argv[i + 1]) {
      limit = Math.min(50, Math.max(1, Number.parseInt(argv[++i], 10) || 10));
    } else if (arg === "--job-id" && argv[i + 1]) {
      jobId = argv[++i];
    } else if (arg === "--no-resume-processing") {
      resumeProcessing = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Drain pending Sent.dm webhook_jobs (local dev).

Options:
  --limit N              Batch size per claim (default 10, max 50)
  --job-id ID            Process one job via begin_webhook_job (same as after() path)
  --no-resume-processing Skip re-running jobs stuck in processing

Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local`);
      process.exit(0);
    }
  }
  return { limit, jobId, resumeProcessing };
}

async function countByStatus(supabase) {
  const statuses = ["pending", "processing", "completed", "failed"];
  const counts = {};
  for (const status of statuses) {
    const { count, error } = await supabase
      .from("webhook_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", status);
    if (error) throw error;
    counts[status] = count ?? 0;
  }
  return counts;
}

async function recentJobs(supabase, n = 5) {
  const { data, error } = await supabase
    .from("webhook_jobs")
    .select("id, status, external_id, last_error, created_at, processed_at")
    .order("created_at", { ascending: false })
    .limit(n);
  if (error) throw error;
  return data ?? [];
}

async function recentInbound(supabase, n = 3) {
  const { data, error } = await supabase
    .from("messages")
    .select("id, direction, conversation_id, external_id, created_at, message_text")
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(n);
  if (error) throw error;
  return data ?? [];
}

loadEnvLocal();

const { limit, jobId, resumeProcessing } = parseArgs(process.argv.slice(2));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local)."
  );
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const {
  claimAndProcessSentDmWebhookJobs,
  processSentDmWebhookJobFromPending,
  runQueuedSentDmInboundJob,
} = await import("../lib/sentdm/process-webhook-job.ts");

console.log("--- Drain Sent.dm webhook_jobs (local dev) ---");

const before = await countByStatus(supabase);
console.log("Before:", before);

if (resumeProcessing) {
  const { data: stuck, error } = await supabase
    .from("webhook_jobs")
    .select("id, payload, metadata")
    .eq("status", "processing");
  if (error) throw error;
  const rows = stuck ?? [];
  if (rows.length === 0) {
    console.log("No processing jobs to resume.");
  } else {
    console.log(`Resuming ${rows.length} processing job(s)…`);
    for (const row of rows) {
      await runQueuedSentDmInboundJob(supabase, {
        id: String(row.id),
        payload:
          row.payload && typeof row.payload === "object" ? row.payload : {},
        metadata:
          row.metadata && typeof row.metadata === "object" ? row.metadata : {},
      });
    }
  }
}

if (jobId) {
  console.log(`Processing single job ${jobId} via begin_webhook_job…`);
  await processSentDmWebhookJobFromPending(supabase, jobId);
} else {
  let total = 0;
  let rounds = 0;
  const maxRounds = 10;
  while (rounds < maxRounds) {
    const processed = await claimAndProcessSentDmWebhookJobs(supabase, limit);
    if (processed === 0) break;
    total += processed;
    rounds += 1;
    console.log(`  round ${rounds}: processed ${processed}`);
  }
  console.log(`Claimed and processed ${total} job(s) in ${rounds} round(s).`);
}

const after = await countByStatus(supabase);
console.log("After:", after);

const jobs = await recentJobs(supabase);
console.log("\nRecent webhook_jobs:");
for (const j of jobs) {
  const err =
    typeof j.last_error === "string" && j.last_error.length > 120
      ? `${j.last_error.slice(0, 120)}…`
      : j.last_error;
  console.log(
    `  ${j.id}  ${j.status}  ext=${j.external_id ?? "—"}  ${err ? `err=${err}` : ""}`
  );
}

const inbound = await recentInbound(supabase);
console.log("\nRecent inbound messages:");
if (inbound.length === 0) {
  console.log("  (none)");
} else {
  for (const m of inbound) {
    const preview =
      typeof m.message_text === "string"
        ? m.message_text.slice(0, 60).replace(/\s+/g, " ")
        : "";
    console.log(
      `  ${m.id}  conv=${m.conversation_id ?? "—"}  ext=${m.external_id ?? "—"}  ${preview}`
    );
  }
}

const stillPending = after.pending ?? 0;
if (stillPending > 0) {
  console.log(
    `\nNote: ${stillPending} job(s) still pending. Re-run drain or check failed rows.`
  );
  process.exitCode = 1;
} else {
  console.log("\nNo pending webhook_jobs remaining.");
}
