/**
 * Production QA — CloseOS inbound / inbox workflow (read-only Supabase checks).
 * Usage: node scripts/qa-inbound-inbox.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  const raw = readFileSync(path, "utf8");
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
}

loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });
const results = [];

function pass(id, detail) {
  results.push({ id, status: "PASS", detail });
  console.log(`PASS  ${id}: ${detail}`);
}

function fail(id, detail) {
  results.push({ id, status: "FAIL", detail });
  console.log(`FAIL  ${id}: ${detail}`);
}

function warn(id, detail) {
  results.push({ id, status: "WARN", detail });
  console.log(`WARN  ${id}: ${detail}`);
}

async function main() {
  const { data: inboundMsgs, error: inboundErr } = await sb
    .from("messages")
    .select(
      "id,direction,status,delivery_status,provider,external_id,created_at,conversation_id,contact_id,ai_generated"
    )
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(10);

  if (inboundErr) {
    fail("1_inbound_messages", inboundErr.message);
  } else if ((inboundMsgs ?? []).length === 0) {
    warn("1_inbound_messages", "No inbound messages in DB yet");
  } else {
    pass(
      "1_inbound_messages",
      `${inboundMsgs.length} recent inbound rows; latest ${inboundMsgs[0].created_at}`
    );
  }

  if (inboundMsgs?.[0]?.contact_id) {
    const { data: contact } = await sb
      .from("contacts")
      .select("id,phone,name,sms_opt_out,cooling_off_until")
      .eq("id", inboundMsgs[0].contact_id)
      .maybeSingle();
    if (contact) {
      pass("1_contact_match", `Contact ${contact.id} phone=${contact.phone ?? "?"}`);
    } else {
      fail("1_contact_match", "Latest inbound contact_id not found");
    }
  }

  if (inboundMsgs?.[0]?.conversation_id) {
    const { data: conv } = await sb
      .from("conversations")
      .select("id,status,last_inbound_at,needs_human,human_takeover,business_id")
      .eq("id", inboundMsgs[0].conversation_id)
      .maybeSingle();
    if (conv) {
      pass("2_conversation", `Conversation ${conv.id} status=${conv.status}`);
    } else {
      fail("2_conversation", "Latest inbound conversation_id not found");
    }
  }

  const { data: jobs, error: jobsErr } = await sb
    .from("webhook_jobs")
    .select("id,status,created_at,processed_at,last_error")
    .order("created_at", { ascending: false })
    .limit(10);

  if (jobsErr) {
    fail("10_webhook_jobs_table", jobsErr.message);
  } else {
    const completed = (jobs ?? []).filter((j) => j.status === "completed").length;
    const failed = (jobs ?? []).filter((j) => j.status === "failed").length;
    pass(
      "10_webhook_jobs_table",
      `${jobs?.length ?? 0} recent jobs (${completed} completed, ${failed} failed)`
    );
  }

  const auditTypes = [
    "webhook_received",
    "webhook_job_created",
    "webhook_job_started",
    "webhook_job_completed",
    "sentdm_loop_received",
    "sentdm_loop_inbound_message_saved",
    "sentdm_loop_outbound_message_saved",
    "sentdm_outbound_send_skipped",
  ];
  const auditCounts = {};
  for (const t of auditTypes) {
    const { count, error } = await sb
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("event_type", t);
    if (error) {
      fail(`10_audit_${t}`, error.message);
    } else {
      auditCounts[t] = count ?? 0;
    }
  }
  const hasChain =
    auditCounts.webhook_received > 0 &&
    auditCounts.webhook_job_completed > 0 &&
    auditCounts.sentdm_loop_inbound_message_saved > 0;
  if (hasChain) {
    pass("10_audit_chain", JSON.stringify(auditCounts));
  } else {
    warn("10_audit_chain", `Partial audit trail: ${JSON.stringify(auditCounts)}`);
  }

  const { data: outboundDelivery } = await sb
    .from("messages")
    .select("id,delivery_status,delivery_updated_at,external_id,status")
    .eq("direction", "outbound")
    .not("delivery_status", "is", null)
    .order("created_at", { ascending: false })
    .limit(5);

  if ((outboundDelivery ?? []).length > 0) {
    pass(
      "9_delivery_callbacks",
      `Outbound delivery statuses: ${[...new Set(outboundDelivery.map((m) => m.delivery_status))].join(", ")}`
    );
  } else {
    warn("9_delivery_callbacks", "No outbound messages with delivery_status yet");
  }

  const { count: pendingCount } = await sb
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "outbound")
    .in("status", ["pending_send", "draft"]);

  pass("8_operator_pending", `${pendingCount ?? 0} outbound pending_send/draft rows`);

  const { data: failedJobs } = await sb
    .from("webhook_jobs")
    .select("id,last_error,created_at")
    .eq("status", "failed")
    .order("created_at", { ascending: false })
    .limit(3);
  if ((failedJobs ?? []).length > 0) {
    warn(
      "10_failed_jobs",
      failedJobs.map((j) => `${j.id}: ${(j.last_error ?? "").slice(0, 120)}`).join(" | ")
    );
  }

  const { data: configs } = await sb
    .from("business_messaging_configs")
    .select("slug,auto_send_enabled,name")
    .limit(3);
  pass("5_auto_send_config", JSON.stringify(configs ?? []));

  const { error: riskColErr } = await sb
    .from("messages")
    .select("id,risk_level,ai_confidence,escalation_required")
    .limit(1);
  if (riskColErr) {
    fail("schema_messages_ai_columns", riskColErr.message);
  } else {
    pass("schema_messages_ai_columns", "risk_level / ai_confidence / escalation_required readable");
  }

  console.log("\n--- QA SUMMARY ---");
  const fails = results.filter((r) => r.status === "FAIL");
  const warns = results.filter((r) => r.status === "WARN");
  console.log(
    `PASS ${results.filter((r) => r.status === "PASS").length} | WARN ${warns.length} | FAIL ${fails.length}`
  );
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
