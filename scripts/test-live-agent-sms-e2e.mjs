#!/usr/bin/env node
/**
 * End-to-end local live agent SMS test against running dev server + Supabase.
 *
 * Requires:
 *   - next dev running (NEXT_PUBLIC_APP_URL)
 *   - CLOSEOS_LIVE_AGENT_TEST_MODE=true
 *   - CLOSEOS_TEST_SMS_ALLOWLIST=+15103756639
 *   - OPENAI_API_KEY, Supabase, Sent.dm keys in .env.local
 *
 * Usage: npm run test:live-agent-sms:e2e
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const TEST_PHONE = "+15103756639";
const INBOUND_TEXT = "Are there available times on Sunday?";

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

loadEnvLocal();

process.env.CLOSEOS_LIVE_AGENT_TEST_MODE ??= "true";
if (!process.env.CLOSEOS_TEST_SMS_ALLOWLIST?.includes(TEST_PHONE)) {
  process.env.CLOSEOS_TEST_SMS_ALLOWLIST = TEST_PHONE;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
  /\/$/,
  ""
);

const { prepareAllowlistedContactForLiveAgentTest } = await import(
  "../lib/sentdm/live-agent-outbound.ts"
);
const {
  claimAndProcessSentDmWebhookJobs,
  processSentDmWebhookJobFromPending,
  runQueuedSentDmInboundJob,
} = await import("../lib/sentdm/process-webhook-job.ts");

console.log("--- Live agent SMS E2E (real webhook path) ---");
console.log(`Phone: ${TEST_PHONE}`);
console.log(`Inbound: "${INBOUND_TEXT}"`);

try {
  await prepareAllowlistedContactForLiveAgentTest(supabase, TEST_PHONE);
  console.log("Prepared allowlisted contact/conversation blockers cleared.");
} catch (e) {
  console.warn("Prepare skipped:", e instanceof Error ? e.message : e);
}

const startedAt = new Date().toISOString();

/** Text-only envelope — no message_id/external_id (avoids Sent.dm GET lookup in local dev). */
const envelope = {
  sub_type: "message.received",
  field: "message",
  payload: {
    from: TEST_PHONE,
    to: process.env.CLOSEOS_SMS_FROM_NUMBER ?? "+15559876543",
    text: INBOUND_TEXT,
    channel: "sms",
  },
  timestamp: startedAt,
};

const webhookRes = await fetch(`${baseUrl}/api/sentdm/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(envelope),
});

const webhookBody = await webhookRes.json().catch(() => ({}));
console.log(`Webhook HTTP ${webhookRes.status}`, webhookBody);

if (!webhookRes.ok) {
  process.exit(1);
}

const jobId = typeof webhookBody.job_id === "string" ? webhookBody.job_id : null;

async function drainWebhookJobs() {
  let processed = 0;

  const { data: processing } = await supabase
    .from("webhook_jobs")
    .select("id, payload, metadata")
    .eq("status", "processing");
  for (const row of processing ?? []) {
    await runQueuedSentDmInboundJob(supabase, {
      id: String(row.id),
      payload:
        row.payload && typeof row.payload === "object" ? row.payload : {},
      metadata:
        row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    });
    processed += 1;
  }

  if (jobId) {
    const { data: job } = await supabase
      .from("webhook_jobs")
      .select("id, status")
      .eq("id", jobId)
      .maybeSingle();
    if (job?.status === "pending") {
      await processSentDmWebhookJobFromPending(supabase, jobId);
      processed += 1;
    }
  }

  for (let i = 0; i < 5; i++) {
    const n = await claimAndProcessSentDmWebhookJobs(supabase, 10);
    if (n === 0) break;
    processed += n;
  }

  return processed;
}

console.log("\nDraining webhook_jobs…");
await new Promise((r) => setTimeout(r, 750));
const processed = await drainWebhookJobs();
console.log(`Processed ${processed} job(s).`);

if (jobId) {
  const { data: jobRow } = await supabase
    .from("webhook_jobs")
    .select("id, status, last_error")
    .eq("id", jobId)
    .maybeSingle();
  if (jobRow) {
    console.log(`Job ${jobId}: status=${jobRow.status} error=${jobRow.last_error ?? "none"}`);
    if (jobRow.status === "failed") {
      process.exit(1);
    }
  }
}

const { data: inboundRows } = await supabase
  .from("messages")
  .select("*")
  .eq("direction", "inbound")
  .eq("contact_phone", TEST_PHONE)
  .gte("created_at", startedAt)
  .order("created_at", { ascending: false })
  .limit(1);

const inbound = inboundRows?.[0] ?? null;
console.log("\nInbound saved:", Boolean(inbound));
if (inbound) {
  console.log("  text:", inbound.message_text);
}

const convId = inbound?.conversation_id;
let outbound = null;

if (convId) {
  const { data: outboundRows } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", convId)
    .eq("direction", "outbound")
    .eq("ai_generated", true)
    .gte("created_at", startedAt)
    .order("created_at", { ascending: false })
    .limit(1);
  outbound = outboundRows?.[0] ?? null;
}

if (!outbound) {
  const { data: fallback } = await supabase
    .from("messages")
    .select("*")
    .eq("direction", "outbound")
    .eq("contact_phone", TEST_PHONE)
    .eq("ai_generated", true)
    .gte("created_at", startedAt)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  outbound = fallback ?? null;
}

if (outbound) {
  const meta =
    outbound.metadata &&
    typeof outbound.metadata === "object" &&
    !Array.isArray(outbound.metadata) ?
      outbound.metadata
    : {};

  console.log("\nOutbound AI:", outbound.message_text);
  console.log("status:", outbound.status, "delivery:", outbound.delivery_status);
  console.log("risk_level:", outbound.risk_level ?? "—");
  console.log("escalation_required:", outbound.escalation_required);
  console.log("model_should_send:", meta.should_send_model);
  console.log("provider_send_blocker:", meta.provider_send_blocker ?? "none");

  const blocker = meta.provider_send_blocker;
  const badStatus = outbound.status === "pending_send" || outbound.status === "needs_human";

  if (blocker) {
    console.error(`\nSend blocked: ${blocker}`);
    if (meta.provider_send_blocker_detail) {
      console.error("detail:", meta.provider_send_blocker_detail);
    }
    process.exit(1);
  }

  if (meta.should_send_model !== true) {
    console.error("\nmodel_should_send is not true");
    process.exit(1);
  }

  if (badStatus && outbound.delivery_status === "not_sent") {
    console.error("\nOutbound not sent — check qa:live-agent-reply");
    process.exit(1);
  }

  if (!/how many players/i.test(String(outbound.message_text ?? ""))) {
    console.warn(
      'Warning: expected qualification reply containing "how many players"'
    );
  }

  console.log("\nRun npm run qa:live-agent-reply for full audit trail.");
} else {
  console.log("No outbound AI message found for this run.");
  process.exit(1);
}
