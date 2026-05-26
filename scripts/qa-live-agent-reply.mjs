#!/usr/bin/env node
/**
 * Debug live conversational agent reply path for allowlisted test phone.
 *
 * Requires .env.local with Supabase + Sent.dm keys.
 * Recommended:
 *   CLOSEOS_LIVE_AGENT_TEST_MODE=true
 *   CLOSEOS_TEST_SMS_ALLOWLIST=+15103756639
 *
 * Usage:
 *   npm run qa:live-agent-reply
 *   npm run qa:live-agent-reply -- --prepare
 *   npm run qa:live-agent-reply -- --phone +15103756639
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

loadEnvLocal();

const args = process.argv.slice(2);
const prepare = args.includes("--prepare");
const phoneArgIdx = args.indexOf("--phone");
const TEST_PHONE =
  phoneArgIdx >= 0 && args[phoneArgIdx + 1] ?
    args[phoneArgIdx + 1].trim()
  : process.env.CLOSEOS_TEST_SMS_ALLOWLIST?.split(/[,;\s]+/)[0]?.trim() ||
    "+15103756639";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const {
  isLiveAgentTestMode,
  isPhoneOnLiveAgentAllowlist,
  prepareAllowlistedContactForLiveAgentTest,
  validateSentDmOutboundPrerequisites,
} = await import("../lib/sentdm/live-agent-outbound.ts");
const { isInboundQuietHoursActive } = await import("../lib/messaging/quiet-hours.ts");
const { isContactInCoolingOff } = await import("../lib/messaging/cooling-off.ts");

console.log("--- CloseOS live agent reply QA ---");
console.log(`Phone: ${TEST_PHONE}`);
console.log(`CLOSEOS_LIVE_AGENT_TEST_MODE=${process.env.CLOSEOS_LIVE_AGENT_TEST_MODE ?? "(unset)"}`);
console.log(
  `CLOSEOS_TEST_SMS_ALLOWLIST=${process.env.CLOSEOS_TEST_SMS_ALLOWLIST ?? "(unset)"}`
);
console.log(`liveAgentTestMode: ${isLiveAgentTestMode()}`);
console.log(`allowlistPassed: ${isPhoneOnLiveAgentAllowlist(TEST_PHONE)}`);
console.log(`quiet_hours_active: ${isInboundQuietHoursActive()}`);
console.log(
  `sentdm_prereq_blocker: ${validateSentDmOutboundPrerequisites() ?? "none"}`
);

if (prepare && isLiveAgentTestMode()) {
  try {
    const prep = await prepareAllowlistedContactForLiveAgentTest(
      supabase,
      TEST_PHONE
    );
    console.log("\nPrepared allowlisted contact for live agent test:", prep);
  } catch (e) {
    console.error("\nPrepare failed:", e instanceof Error ? e.message : e);
  }
}

const { data: contact } = await supabase
  .from("contacts")
  .select("*")
  .eq("phone", TEST_PHONE)
  .maybeSingle();

if (!contact) {
  console.log("\nNo contact row for test phone yet — post an inbound webhook first.");
  process.exit(0);
}

console.log("\nContact:");
console.log(`  id: ${contact.id}`);
console.log(`  sms_opt_out: ${contact.sms_opt_out}`);
console.log(`  cooling_off_until: ${contact.cooling_off_until ?? "null"}`);
console.log(`  cooling_off_active: ${isContactInCoolingOff(contact)}`);

const { data: conversations } = await supabase
  .from("conversations")
  .select("*")
  .eq("contact_id", contact.id)
  .order("updated_at", { ascending: false })
  .limit(3);

let conversation = conversations?.[0] ?? null;

if (!conversation) {
  const { data: recentMsg } = await supabase
    .from("messages")
    .select("conversation_id")
    .eq("contact_phone", TEST_PHONE)
    .not("conversation_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recentMsg?.conversation_id) {
    const { data: convByMsg } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", recentMsg.conversation_id)
      .maybeSingle();
    conversation = convByMsg ?? null;
  }
}
if (conversation) {
  console.log("\nLatest conversation:");
  console.log(`  id: ${conversation.id}`);
  console.log(`  automation_enabled: ${conversation.automation_enabled}`);
  console.log(`  human_takeover: ${conversation.human_takeover}`);
  console.log(`  needs_human: ${conversation.needs_human}`);
  console.log(`  status: ${conversation.status}`);
} else {
  console.log("\nNo conversation for contact.");
}

const convId = conversation?.id;
let latestInbound = null;
let latestOutbound = null;

if (convId) {
  const { data: inboundRows } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", convId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1);
  latestInbound = inboundRows?.[0] ?? null;

  const { data: outboundRows } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", convId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1);
  latestOutbound = outboundRows?.[0] ?? null;
}

console.log("\nLatest inbound:");
if (latestInbound) {
  console.log(`  id: ${latestInbound.id}`);
  console.log(`  text: ${String(latestInbound.message_text ?? "").slice(0, 120)}`);
  console.log(`  created_at: ${latestInbound.created_at}`);
} else {
  console.log("  (none)");
}

console.log("\nLatest outbound AI:");
if (latestOutbound) {
  const meta =
    latestOutbound.metadata &&
    typeof latestOutbound.metadata === "object" &&
    !Array.isArray(latestOutbound.metadata) ?
      latestOutbound.metadata
    : {};
  console.log(`  id: ${latestOutbound.id}`);
  console.log(`  text: ${String(latestOutbound.message_text ?? "").slice(0, 120)}`);
  console.log(`  status: ${latestOutbound.status}`);
  console.log(`  delivery_status: ${latestOutbound.delivery_status}`);
  console.log(`  escalation_required: ${latestOutbound.escalation_required}`);
  console.log(`  risk_level: ${latestOutbound.risk_level ?? "—"}`);
  console.log(`  model_should_send: ${meta.should_send_model ?? "—"}`);
  console.log(`  auto_send_reason: ${meta.auto_send_reason ?? "—"}`);
  console.log(`  provider_send_blocker: ${meta.provider_send_blocker ?? "—"}`);
  console.log(`  provider_send_blocker_detail: ${meta.provider_send_blocker_detail ?? "—"}`);
  console.log(`  allowlist_passed: ${meta.allowlist_passed ?? "—"}`);
  console.log(`  quiet_hours_active(meta): ${meta.quiet_hours_active ?? "—"}`);
} else {
  console.log("  (none)");
}

const { data: audits } = await supabase
  .from("audit_logs")
  .select("event_type, metadata, created_at")
  .in("event_type", [
    "sentdm_outbound_send_attempted",
    "sentdm_outbound_send_succeeded",
    "sentdm_outbound_send_failed",
    "sentdm_outbound_send_skipped",
    "sentdm_outbound_send_blocked_policy",
  ])
  .order("created_at", { ascending: false })
  .limit(8);

console.log("\nRecent outbound send audits:");
if (!audits?.length) {
  console.log("  (none)");
} else {
  for (const row of audits) {
  console.log(
    `  ${row.created_at}  ${row.event_type}  ${JSON.stringify(row.metadata ?? {})}`
  );
  }
}

const sendAttempted = audits?.some(
  (a) => a.event_type === "sentdm_outbound_send_attempted"
);
const sendSucceeded = audits?.find(
  (a) => a.event_type === "sentdm_outbound_send_succeeded"
);
const sendFailed = audits?.find(
  (a) => a.event_type === "sentdm_outbound_send_failed"
);
const sendSkipped = audits?.find(
  (a) => a.event_type === "sentdm_outbound_send_skipped"
);

console.log("\nSummary:");
console.log(`  sendSentDmMessage attempted: ${Boolean(sendAttempted)}`);
if (sendSucceeded) {
  const m =
    sendSucceeded.metadata &&
    typeof sendSucceeded.metadata === "object" &&
    !Array.isArray(sendSucceeded.metadata) ?
      sendSucceeded.metadata
    : {};
  console.log(
    `  Sent.dm result: succeeded provider_message_id=${JSON.stringify(m.provider_message_id ?? null)}`
  );
} else if (sendFailed) {
  const m =
    sendFailed.metadata &&
    typeof sendFailed.metadata === "object" &&
    !Array.isArray(sendFailed.metadata) ?
      sendFailed.metadata
    : {};
  console.log(
    `  Sent.dm result: failed error=${JSON.stringify(m.error ?? null)}`
  );
} else if (sendSkipped) {
  const m =
    sendSkipped.metadata &&
    typeof sendSkipped.metadata === "object" &&
    !Array.isArray(sendSkipped.metadata) ?
      sendSkipped.metadata
    : {};
  console.log(
    `  send skipped — blocker: ${m.provider_send_blocker ?? m.policy_blocked ?? "unknown"}`
  );
  console.log(`  detail: ${m.provider_send_blocker_detail ?? m.detail ?? "—"}`);
}

if (latestOutbound?.metadata?.provider_send_blocker) {
  process.exitCode = 1;
}
